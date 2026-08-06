#import "TLAccessibilityObserver.h"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

#import "TLComposerClassifier.h"
#import "TLProtocol.h"

static void TLAXNotificationCallback(AXObserverRef observer,
                                     AXUIElementRef element,
                                     CFStringRef notification,
                                     void *context);

@implementation TLAccessibilityObserver {
  TLMessageHandler _messageHandler;
  BOOL _active;
  BOOL _stopped;
  pid_t _cursorPID;
  AXUIElementRef _applicationElement;
  AXUIElementRef _focusedElement;
  AXObserverRef _observer;
  BOOL _applicationWindowNotificationRegistered;
  BOOL _applicationFocusNotificationRegistered;
  BOOL _focusedValueNotificationRegistered;
  BOOL _focusedDestroyedNotificationRegistered;
  NSTimer *_draftPollTimer;
  NSTimer *_heartbeatTimer;
  id _applicationActivationToken;
  NSString *_lastState;
  NSNumber *_lastCharacterCount;
  NSNumber *_lastPermissionTrusted;
  NSUInteger _activationGeneration;
  NSUInteger _observation;
}

- (instancetype)initWithMessageHandler:(TLMessageHandler)messageHandler {
  self = [super init];
  if (self != nil) {
    _messageHandler = [messageHandler copy];
    _cursorPID = -1;

    __weak TLAccessibilityObserver *weakSelf = self;
    _applicationActivationToken = [[[NSWorkspace sharedWorkspace] notificationCenter]
        addObserverForName:NSWorkspaceDidActivateApplicationNotification
                    object:nil
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(__unused NSNotification *notification) {
                  [weakSelf refreshObservation];
                }];

    _heartbeatTimer = [NSTimer scheduledTimerWithTimeInterval:1.0
                                                       repeats:YES
                                                         block:^(__unused NSTimer *timer) {
      [weakSelf heartbeat];
    }];
    [self emitPermissionState];
  }
  return self;
}

- (void)dealloc {
  [self stop];
}

- (void)setActive:(BOOL)active generation:(NSUInteger)generation {
  if (_stopped) return;
  _activationGeneration = generation;
  if (_active == active) return;
  _active = active;
  _observation += 1;
  _lastState = nil;
  _lastCharacterCount = nil;

  if (!active) {
    [self tearDownCursorObservation];
    return;
  }
  [self refreshObservation];
}

- (void)requestPermission {
  if (_stopped) return;
  NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
  (void)AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  [self emitPermissionState];
  if (_active) [self refreshObservation];
}

- (void)emitDiagnosticSnapshot {
  if (_stopped) return;

  NSMutableDictionary *metadata = [NSMutableDictionary dictionary];
  metadata[@"trusted"] = [NSNumber numberWithBool:AXIsProcessTrusted() ? YES : NO];
  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  metadata[@"frontmostIsCursor"] = [NSNumber numberWithBool:
      frontmost.bundleIdentifier != nil &&
      TLIsAllowedCursorBundleIdentifier(frontmost.bundleIdentifier)];

  if (AXIsProcessTrusted() &&
      frontmost.bundleIdentifier != nil &&
      TLIsAllowedCursorBundleIdentifier(frontmost.bundleIdentifier)) {
    AXUIElementRef application = AXUIElementCreateApplication(frontmost.processIdentifier);
    CFTypeRef rawFocused = NULL;
    if (AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute, &rawFocused) ==
            kAXErrorSuccess &&
        rawFocused != NULL && CFGetTypeID(rawFocused) == AXUIElementGetTypeID()) {
      NSDictionary *snapshot = TLSanitizedSnapshotForElement((AXUIElementRef)rawFocused, 8);
      metadata[@"focused"] = [self diagnosticMetadataFromSnapshot:snapshot];
      metadata[@"classifiedAsComposer"] =
          [NSNumber numberWithBool:TLMetadataLooksLikeCursorComposer(snapshot)];
    }
    if (rawFocused != NULL) CFRelease(rawFocused);
    CFRelease(application);
  }

  NSDictionary *message = @{
    @"version" : @(TLProtocolVersion),
    @"type" : @"diagnostic",
    @"metadata" : metadata,
  };
  NSString *serializationError = nil;
  if (TLSerializeMessage(message, &serializationError) == nil) {
    // Keep diagnostics responsive even if future Cursor metadata reaches the
    // per-field caps but the combined JSON frame would exceed 4 KiB.
    message = @{
      @"version" : @(TLProtocolVersion),
      @"type" : @"diagnostic",
      @"metadata" : @{
        @"trusted" : metadata[@"trusted"] ?: @NO,
        @"frontmostIsCursor" : metadata[@"frontmostIsCursor"] ?: @NO,
      },
    };
  }
  [self emit:message];
}

- (void)stop {
  if (_stopped) return;
  _stopped = YES;
  _active = NO;
  [_heartbeatTimer invalidate];
  _heartbeatTimer = nil;
  [_draftPollTimer invalidate];
  _draftPollTimer = nil;
  [self tearDownCursorObservation];
  if (_applicationActivationToken != nil) {
    [[[NSWorkspace sharedWorkspace] notificationCenter]
        removeObserver:_applicationActivationToken];
    _applicationActivationToken = nil;
  }
}

- (void)heartbeat {
  if (!_active || _stopped) return;
  BOOL trusted = AXIsProcessTrusted() ? YES : NO;
  if (_lastPermissionTrusted == nil ||
      _lastPermissionTrusted.boolValue != trusted) {
    [self emitPermissionState];
  }
  if (!trusted) {
    [self tearDownCursorObservation];
    return;
  }

  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (frontmost.bundleIdentifier == nil ||
      !TLIsAllowedCursorBundleIdentifier(frontmost.bundleIdentifier) ||
      frontmost.processIdentifier != _cursorPID) {
    [self refreshObservation];
    return;
  }
  if (_observer == NULL || _applicationElement == NULL) {
    [self refreshObservation];
    return;
  }
  if (_focusedElement == NULL) {
    // AX metadata and values can fail transiently while Electron rebuilds the
    // composer. Retry metadata-only classification without ever reading an
    // unvalidated element, so observation recovers without a focus change.
    [self refreshFocusedElement];
  }
}

- (void)emitPermissionState {
  BOOL trusted = AXIsProcessTrusted() ? YES : NO;
  _lastPermissionTrusted = [NSNumber numberWithBool:trusted];
  [self emit:@{
    @"version" : @(TLProtocolVersion),
    @"type" : @"permission",
    @"trusted" : [NSNumber numberWithBool:trusted],
  }];
}

- (void)refreshObservation {
  if (!_active || _stopped) return;
  if (!AXIsProcessTrusted()) {
    [self emitPermissionState];
    [self tearDownCursorObservation];
    return;
  }

  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (frontmost.bundleIdentifier == nil ||
      !TLIsAllowedCursorBundleIdentifier(frontmost.bundleIdentifier)) {
    [self tearDownCursorObservation];
    [self emitState:@"waiting-for-cursor"];
    return;
  }

  if (_observer == NULL || _cursorPID != frontmost.processIdentifier) {
    [self tearDownCursorObservation];
    _cursorPID = frontmost.processIdentifier;
    _applicationElement = AXUIElementCreateApplication(_cursorPID);

    AXError observerResult = AXObserverCreate(
        _cursorPID, TLAXNotificationCallback, &_observer);
    if (observerResult != kAXErrorSuccess || _observer == NULL) {
      [self emitError:@"cursor-observer-unavailable"];
      [self emitState:@"unsupported"];
      [self tearDownCursorObservation];
      return;
    }

    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_observer),
                       kCFRunLoopCommonModes);
    AXError windowResult = AXObserverAddNotification(
        _observer, _applicationElement, kAXFocusedWindowChangedNotification,
        (__bridge void *)self);
    _applicationWindowNotificationRegistered =
        windowResult == kAXErrorSuccess ||
        windowResult == kAXErrorNotificationAlreadyRegistered;
    AXError focusResult = AXObserverAddNotification(
        _observer, _applicationElement, kAXFocusedUIElementChangedNotification,
        (__bridge void *)self);
    _applicationFocusNotificationRegistered =
        focusResult == kAXErrorSuccess ||
        focusResult == kAXErrorNotificationAlreadyRegistered;
    if (!_applicationWindowNotificationRegistered ||
        !_applicationFocusNotificationRegistered) {
      [self tearDownCursorObservation];
      [self emitError:@"cursor-observer-unavailable"];
      [self emitState:@"unsupported"];
      return;
    }
  }

  [self refreshFocusedElement];
}

- (void)refreshFocusedElement {
  _observation += 1;
  [self tearDownFocusedObservation];
  if (_applicationElement == NULL || _observer == NULL) {
    [self emitState:@"waiting-for-chat"];
    return;
  }

  CFTypeRef rawFocused = NULL;
  AXError result = AXUIElementCopyAttributeValue(
      _applicationElement, kAXFocusedUIElementAttribute, &rawFocused);
  if (result != kAXErrorSuccess || rawFocused == NULL ||
      CFGetTypeID(rawFocused) != AXUIElementGetTypeID()) {
    if (rawFocused != NULL) CFRelease(rawFocused);
    [self emitState:@"waiting-for-chat"];
    return;
  }

  AXUIElementRef candidate = (AXUIElementRef)rawFocused;
  NSDictionary *snapshot = TLClassifierSnapshotForElement(candidate, 8);
  if (!TLMetadataLooksLikeCursorComposer(snapshot)) {
    CFRelease(rawFocused);
    [self emitState:@"waiting-for-chat"];
    return;
  }

  _focusedElement = candidate;
  _lastCharacterCount = nil;
  AXError valueResult = AXObserverAddNotification(
      _observer, _focusedElement, kAXValueChangedNotification,
      (__bridge void *)self);
  _focusedValueNotificationRegistered =
      valueResult == kAXErrorSuccess ||
      valueResult == kAXErrorNotificationAlreadyRegistered;
  AXError destroyedResult = AXObserverAddNotification(
      _observer, _focusedElement, kAXUIElementDestroyedNotification,
      (__bridge void *)self);
  _focusedDestroyedNotificationRegistered =
      destroyedResult == kAXErrorSuccess ||
      destroyedResult == kAXErrorNotificationAlreadyRegistered;

  // Electron versions differ in value/destroyed notification support. Either
  // registration may fail without weakening the boundary: the bounded poll
  // independently revalidates trust, frontmost PID, focused-element identity,
  // and the classifier before every value read.
  __weak TLAccessibilityObserver *weakSelf = self;
  _draftPollTimer = [NSTimer scheduledTimerWithTimeInterval:0.15
                                                    repeats:YES
                                                      block:^(__unused NSTimer *timer) {
    [weakSelf readAndEmitDraftLength];
  }];
  [self readAndEmitDraftLength];
}

- (void)handleAXNotification:(CFStringRef)notification {
  if (!_active || _stopped) return;
  if (CFEqual(notification, kAXValueChangedNotification)) {
    [self readAndEmitDraftLength];
    return;
  }
  if (CFEqual(notification, kAXUIElementDestroyedNotification)) {
    [self refreshFocusedElement];
    return;
  }
  [self refreshObservation];
}

- (void)readAndEmitDraftLength {
  if (!_active || _stopped || _focusedElement == NULL) return;
  if (![self focusedElementRemainsValid]) return;

  CFTypeRef rawValue = NULL;
  AXError result = AXUIElementCopyAttributeValue(
      _focusedElement, kAXValueAttribute, &rawValue);
  if (result != kAXErrorSuccess || rawValue == NULL ||
      CFGetTypeID(rawValue) != CFStringGetTypeID()) {
    if (rawValue != NULL) CFRelease(rawValue);
    _observation += 1;
    [self tearDownFocusedObservation];
    [self emitState:@"waiting-for-chat"];
    return;
  }

  NSString *value = CFBridgingRelease(rawValue);
  const NSUInteger characters = TLCursorDraftUnicodeScalarCount(value);
  value = nil;
  if (characters > TLMaximumDraftCharacters) {
    [self emitError:@"draft-too-large"];
    return;
  }
  if ([_lastCharacterCount isEqualToNumber:@(characters)]) return;
  _lastCharacterCount = @(characters);

  if (characters == 0) {
    [self emitState:@"draft-empty"];
  } else {
    _lastState = nil;
    [self emit:@{
      @"version" : @(TLProtocolVersion),
      @"type" : @"draft-length",
      @"characters" : @(characters),
      @"generation" : @(_activationGeneration),
      @"observation" : @(_observation),
    }];
  }
}

- (void)emitState:(NSString *)state {
  if ([_lastState isEqualToString:state]) return;
  _lastState = state;
  _lastCharacterCount = nil;
  [self emit:@{
    @"version" : @(TLProtocolVersion),
    @"type" : @"state",
    @"state" : state,
    @"generation" : @(_activationGeneration),
    @"observation" : @(_observation),
  }];
}

- (void)emitError:(NSString *)code {
  [self emit:@{
    @"version" : @(TLProtocolVersion),
    @"type" : @"error",
    @"code" : code,
    @"generation" : @(_activationGeneration),
  }];
}

- (void)emit:(NSDictionary *)message {
  if (!_stopped && _messageHandler != nil) _messageHandler(message);
}

- (BOOL)focusedElementRemainsValid {
  if (!_active || _stopped || _focusedElement == NULL) return NO;
  if (!AXIsProcessTrusted()) {
    [self emitPermissionState];
    [self tearDownCursorObservation];
    return NO;
  }

  NSRunningApplication *frontmost = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (frontmost.bundleIdentifier == nil ||
      !TLIsAllowedCursorBundleIdentifier(frontmost.bundleIdentifier) ||
      frontmost.processIdentifier != _cursorPID) {
    [self refreshObservation];
    return NO;
  }

  if (_applicationElement == NULL) {
    [self refreshObservation];
    return NO;
  }

  CFTypeRef rawFocused = NULL;
  AXError result = AXUIElementCopyAttributeValue(
      _applicationElement, kAXFocusedUIElementAttribute, &rawFocused);
  BOOL isSameElement = result == kAXErrorSuccess && rawFocused != NULL &&
      CFGetTypeID(rawFocused) == AXUIElementGetTypeID() &&
      CFEqual(rawFocused, _focusedElement);
  if (!isSameElement) {
    if (rawFocused != NULL) CFRelease(rawFocused);
    [self refreshFocusedElement];
    return NO;
  }

  NSDictionary *snapshot = TLClassifierSnapshotForElement(
      (AXUIElementRef)rawFocused, 8);
  CFRelease(rawFocused);
  if (!TLMetadataLooksLikeCursorComposer(snapshot)) {
    _observation += 1;
    [self tearDownFocusedObservation];
    [self emitState:@"waiting-for-chat"];
    return NO;
  }
  return YES;
}

- (NSDictionary *)diagnosticMetadataFromSnapshot:(NSDictionary *)snapshot {
  NSMutableDictionary *diagnostic = [NSMutableDictionary dictionary];
  for (NSString *key in @[@"role", @"subrole", @"identifier", @"domIdentifier",
                           @"domClasses",
                           @"valueAttributeSupported",
                           @"attributeNames"]) {
    id value = snapshot[key];
    if (value != nil) diagnostic[key] = value;
  }

  NSMutableArray *parents = [NSMutableArray array];
  NSArray *snapshotParents = [snapshot[@"parents"] isKindOfClass:NSArray.class]
      ? snapshot[@"parents"] : @[];
  for (id item in snapshotParents) {
    if (![item isKindOfClass:NSDictionary.class]) continue;
    NSMutableDictionary *parent = [NSMutableDictionary dictionary];
    for (NSString *key in @[@"role", @"subrole", @"identifier", @"domIdentifier",
                             @"domClasses"]) {
      id value = item[key];
      if (value != nil) parent[key] = value;
    }
    [parents addObject:parent];
  }
  diagnostic[@"parents"] = parents;
  return diagnostic;
}

- (void)tearDownFocusedObservation {
  [_draftPollTimer invalidate];
  _draftPollTimer = nil;
  _lastCharacterCount = nil;

  if (_observer != NULL && _focusedElement != NULL) {
    if (_focusedValueNotificationRegistered) {
      AXObserverRemoveNotification(_observer, _focusedElement,
                                   kAXValueChangedNotification);
    }
    if (_focusedDestroyedNotificationRegistered) {
      AXObserverRemoveNotification(_observer, _focusedElement,
                                   kAXUIElementDestroyedNotification);
    }
  }
  _focusedValueNotificationRegistered = NO;
  _focusedDestroyedNotificationRegistered = NO;
  if (_focusedElement != NULL) {
    CFRelease(_focusedElement);
    _focusedElement = NULL;
  }
}

- (void)tearDownCursorObservation {
  _observation += 1;
  [self tearDownFocusedObservation];
  if (_observer != NULL) {
    if (_applicationElement != NULL) {
      if (_applicationWindowNotificationRegistered) {
        AXObserverRemoveNotification(_observer, _applicationElement,
                                     kAXFocusedWindowChangedNotification);
      }
      if (_applicationFocusNotificationRegistered) {
        AXObserverRemoveNotification(_observer, _applicationElement,
                                     kAXFocusedUIElementChangedNotification);
      }
    }
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(_observer),
                          kCFRunLoopCommonModes);
    CFRelease(_observer);
    _observer = NULL;
  }
  _applicationWindowNotificationRegistered = NO;
  _applicationFocusNotificationRegistered = NO;
  if (_applicationElement != NULL) {
    CFRelease(_applicationElement);
    _applicationElement = NULL;
  }
  _cursorPID = -1;
}

@end

static void TLAXNotificationCallback(__unused AXObserverRef observer,
                                     __unused AXUIElementRef element,
                                     CFStringRef notification,
                                     void *context) {
  TLAccessibilityObserver *instance = (__bridge TLAccessibilityObserver *)context;
  [instance handleAXNotification:notification];
}
