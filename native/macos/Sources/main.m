#import <Foundation/Foundation.h>

#import <dispatch/dispatch.h>
#import <signal.h>
#import <unistd.h>

#import "TLAccessibilityObserver.h"
#import "TLComposerClassifier.h"
#import "TLProtocol.h"

typedef void (^TLCommandHandler)(NSDictionary *command);
typedef void (^TLEndOfInputHandler)(void);

@interface TLCommandReader : NSObject
- (instancetype)initWithCommandHandler:(TLCommandHandler)commandHandler
                       endOfInputHandler:(TLEndOfInputHandler)endOfInputHandler;
- (void)start;
- (void)stop;
@end

@implementation TLCommandReader {
  TLCommandHandler _commandHandler;
  TLEndOfInputHandler _endOfInputHandler;
  dispatch_source_t _source;
  NSMutableData *_buffer;
  BOOL _discardingOversizedLine;
}

- (instancetype)initWithCommandHandler:(TLCommandHandler)commandHandler
                       endOfInputHandler:(TLEndOfInputHandler)endOfInputHandler {
  self = [super init];
  if (self != nil) {
    _commandHandler = [commandHandler copy];
    _endOfInputHandler = [endOfInputHandler copy];
    _buffer = [NSMutableData data];
  }
  return self;
}

- (void)start {
  if (_source != nil) return;
  _source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0,
                                   dispatch_get_main_queue());
  __weak TLCommandReader *weakSelf = self;
  dispatch_source_set_event_handler(_source, ^{
    [weakSelf readAvailableInput];
  });
  dispatch_source_set_cancel_handler(_source, ^{});
  dispatch_resume(_source);
}

- (void)stop {
  if (_source != nil) {
    dispatch_source_cancel(_source);
    _source = nil;
  }
}

- (void)readAvailableInput {
  uint8_t bytes[4096];
  ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
  if (count == 0) {
    [self stop];
    if (_endOfInputHandler != nil) _endOfInputHandler();
    return;
  }
  if (count < 0) return;
  [_buffer appendBytes:bytes length:(NSUInteger)count];
  [self consumeLines];
}

- (void)consumeLines {
  while (_buffer.length > 0) {
    const uint8_t *bytes = _buffer.bytes;
    NSUInteger newlineIndex = NSNotFound;
    for (NSUInteger index = 0; index < _buffer.length; index += 1) {
      if (bytes[index] == '\n') {
        newlineIndex = index;
        break;
      }
    }

    if (_discardingOversizedLine) {
      if (newlineIndex == NSNotFound) {
        [_buffer setLength:0];
        return;
      }
      [_buffer replaceBytesInRange:NSMakeRange(0, newlineIndex + 1)
                         withBytes:NULL
                            length:0];
      _discardingOversizedLine = NO;
      continue;
    }

    if (newlineIndex == NSNotFound) {
      if (_buffer.length > TLMaximumProtocolLineBytes - 1) {
        fprintf(stderr, "protocol-line-too-long\n");
        [_buffer setLength:0];
        _discardingOversizedLine = YES;
      }
      return;
    }

    if (newlineIndex + 1 > TLMaximumProtocolLineBytes) {
      fprintf(stderr, "protocol-line-too-long\n");
      [_buffer replaceBytesInRange:NSMakeRange(0, newlineIndex + 1)
                         withBytes:NULL
                            length:0];
      continue;
    }

    NSUInteger lineLength = newlineIndex;
    if (lineLength > 0 && bytes[lineLength - 1] == '\r') lineLength -= 1;
    NSData *line = [_buffer subdataWithRange:NSMakeRange(0, lineLength)];
    [_buffer replaceBytesInRange:NSMakeRange(0, newlineIndex + 1)
                       withBytes:NULL
                          length:0];
    if (line.length == 0) continue;

    NSString *errorCode = nil;
    NSDictionary *command = TLParseCommand(line, &errorCode);
    if (command == nil) {
      fprintf(stderr, "%s\n", (errorCode ?: @"invalid-command").UTF8String);
      continue;
    }
    if (_commandHandler != nil) _commandHandler(command);
  }
}

@end

static BOOL TLWriteMessage(NSDictionary *message) {
  NSString *errorCode = nil;
  NSData *line = TLSerializeMessage(message, &errorCode);
  if (line == nil) {
    fprintf(stderr, "%s\n", (errorCode ?: @"output-error").UTF8String);
    return NO;
  }

  const uint8_t *bytes = line.bytes;
  NSUInteger remaining = line.length;
  while (remaining > 0) {
    ssize_t count = write(STDOUT_FILENO, bytes, remaining);
    if (count <= 0) return NO;
    bytes += count;
    remaining -= (NSUInteger)count;
  }
  return YES;
}

static int TLRunSelfTests(void) {
#define TL_ASSERT(condition, code) \
  do {                              \
    if (!(condition)) {             \
      fprintf(stderr, "%s\n", code); \
      return 1;                     \
    }                               \
  } while (0)

  TL_ASSERT(TLUnicodeScalarCount(@"A🙂B") == 3, "self-test-unicode-emoji");
  TL_ASSERT(TLUnicodeScalarCount(@"e\u0301") == 2, "self-test-unicode-composed");
  TL_ASSERT(TLCursorDraftUnicodeScalarCount(@"\n") == 0,
            "self-test-unicode-empty-sentinel");
  TL_ASSERT(TLCursorDraftUnicodeScalarCount(@"hello") == 5,
            "self-test-unicode-draft");
  TL_ASSERT(TLIsAllowedCursorBundleIdentifier(@"com.todesktop.230313mzl4w4u92"),
            "self-test-bundle-allow");
  TL_ASSERT(!TLIsAllowedCursorBundleIdentifier(@"com.apple.TextEdit"),
            "self-test-bundle-deny");

  NSDictionary *composer = @{
    @"role" : (__bridge NSString *)kAXTextAreaRole,
    @"subrole" : @"",
    @"identifier" : @"",
    @"domIdentifier" : @"",
    @"domClasses" : @[@"aislash-editor-input"],
    @"valueAttributeSupported" : @YES,
    @"parents" : @[@{
      @"role" : @"AXGroup",
      @"subrole" : @"",
      @"identifier" : @"",
      @"domIdentifier" : @"",
      @"domClasses" : @[@"composer-input-blur-wrapper"],
    }],
  };
  TL_ASSERT(TLMetadataLooksLikeCursorComposer(composer), "self-test-classifier-allow");

  NSMutableDictionary *missingAncestor = [composer mutableCopy];
  missingAncestor[@"parents"] = @[];
  TL_ASSERT(!TLMetadataLooksLikeCursorComposer(missingAncestor),
            "self-test-classifier-requires-ancestor");

  NSMutableDictionary *missingInputClass = [composer mutableCopy];
  missingInputClass[@"domClasses"] = @[];
  TL_ASSERT(!TLMetadataLooksLikeCursorComposer(missingInputClass),
            "self-test-classifier-requires-input-class");

  NSMutableDictionary *editor = [composer mutableCopy];
  editor[@"domClasses"] = @[];
  editor[@"parents"] = @[];
  TL_ASSERT(!TLMetadataLooksLikeCursorComposer(editor), "self-test-classifier-editor");

  NSMutableDictionary *search = [composer mutableCopy];
  search[@"domClasses"] = @[];
  search[@"parents"] = @[];
  TL_ASSERT(!TLMetadataLooksLikeCursorComposer(search), "self-test-classifier-search");

  NSString *longMetadata = [@"x"
      stringByPaddingToLength:TLMaximumDiagnosticStringLength + 1
                   withString:@"x"
              startingAtIndex:0];
  TL_ASSERT(TLSanitizeDiagnosticString(longMetadata).length ==
                TLMaximumDiagnosticStringLength,
            "self-test-diagnostic-string-bound");
  NSString *surrogateBoundary = [[@"x"
      stringByPaddingToLength:TLMaximumDiagnosticStringLength - 1
                   withString:@"x"
              startingAtIndex:0] stringByAppendingString:@"🙂"];
  TL_ASSERT(TLSanitizeDiagnosticString(surrogateBoundary).length ==
                TLMaximumDiagnosticStringLength - 1,
            "self-test-diagnostic-surrogate-boundary");
  NSMutableArray<NSString *> *manyClasses = [NSMutableArray array];
  for (NSUInteger index = 0;
       index < TLMaximumDiagnosticClassCount + 1; index += 1) {
    [manyClasses addObject:longMetadata];
  }
  NSArray<NSString *> *boundedClasses = TLSanitizeDiagnosticStringArray(
      manyClasses, TLMaximumDiagnosticClassCount);
  TL_ASSERT(boundedClasses.count == TLMaximumDiagnosticClassCount &&
                [boundedClasses.lastObject length] ==
                    TLMaximumDiagnosticStringLength,
            "self-test-diagnostic-array-bound");

  NSString *parseError = nil;
  NSString *validCommandJSON =
      @"{\"version\":1,\"command\":\"set-active\",\"active\":true,\"generation\":1}";
  NSData *validCommand = [validCommandJSON
      dataUsingEncoding:NSUTF8StringEncoding];
  TL_ASSERT(TLParseCommand(validCommand, &parseError) != nil, "self-test-protocol-valid");
  NSData *booleanVersion = [@"{\"version\":true,\"command\":\"diagnose\"}"
      dataUsingEncoding:NSUTF8StringEncoding];
  TL_ASSERT(TLParseCommand(booleanVersion, &parseError) == nil,
            "self-test-protocol-boolean-version");
  NSData *fractionalVersion = [@"{\"version\":1.5,\"command\":\"diagnose\"}"
      dataUsingEncoding:NSUTF8StringEncoding];
  TL_ASSERT(TLParseCommand(fractionalVersion, &parseError) == nil,
            "self-test-protocol-fractional-version");
  NSData *fractionalGeneration = [@"{\"version\":1,\"command\":\"set-active\",\"active\":true,\"generation\":1.5}"
      dataUsingEncoding:NSUTF8StringEncoding];
  TL_ASSERT(TLParseCommand(fractionalGeneration, &parseError) == nil,
            "self-test-protocol-generation");
  NSData *extraField = [@"{\"version\":1,\"command\":\"shutdown\",\"text\":\"secret\"}"
      dataUsingEncoding:NSUTF8StringEncoding];
  TL_ASSERT(TLParseCommand(extraField, &parseError) == nil, "self-test-protocol-extra");
  NSString *maximumPayload = [validCommandJSON
      stringByPaddingToLength:TLMaximumProtocolLineBytes - 1
                   withString:@" "
              startingAtIndex:0];
  NSData *maximumPayloadData = [maximumPayload dataUsingEncoding:NSUTF8StringEncoding];
  TL_ASSERT(maximumPayloadData.length == TLMaximumProtocolLineBytes - 1 &&
                TLParseCommand(maximumPayloadData, &parseError) != nil,
            "self-test-protocol-maximum-payload");
  NSString *oversizedPayload = [maximumPayload stringByAppendingString:@" "];
  TL_ASSERT(TLParseCommand(
                [oversizedPayload dataUsingEncoding:NSUTF8StringEncoding],
                &parseError) == nil,
            "self-test-protocol-oversized-payload");

  NSDictionary *lengthMessage = @{
    @"version" : @1,
    @"type" : @"draft-length",
    @"characters" : @123,
    @"generation" : @1,
    @"observation" : @1,
  };
  NSData *serialized = TLSerializeMessage(lengthMessage, &parseError);
  TL_ASSERT(serialized != nil, "self-test-protocol-serialize");
  NSString *serializedString = [[NSString alloc] initWithData:serialized
                                                     encoding:NSUTF8StringEncoding];
  TL_ASSERT([serializedString rangeOfString:@"prompt"].location == NSNotFound &&
                [serializedString rangeOfString:@"text"].location == NSNotFound,
            "self-test-protocol-content-leak");

  (void)write(STDOUT_FILENO, "ok\n", 3);
  return 0;
#undef TL_ASSERT
}

int main(void) {
  @autoreleasepool {
    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    if ([arguments containsObject:@"--version"]) {
      (void)write(STDOUT_FILENO, "tokenlens-ax-observer 1\n", 24);
      return 0;
    }
    if ([arguments containsObject:@"--self-test"]) {
      return TLRunSelfTests();
    }

    __block BOOL stopping = NO;
    __block TLAccessibilityObserver *observer = nil;
    __block TLCommandReader *reader = nil;
    void (^shutdown)(void) = ^{
      if (stopping) return;
      stopping = YES;
      [reader stop];
      [observer stop];
      CFRunLoopStop(CFRunLoopGetMain());
    };

    observer = [[TLAccessibilityObserver alloc]
        initWithMessageHandler:^(NSDictionary *message) {
          (void)TLWriteMessage(message);
        }];
    reader = [[TLCommandReader alloc]
        initWithCommandHandler:^(NSDictionary *command) {
          NSString *name = command[@"command"];
          if ([name isEqualToString:@"set-active"]) {
            [observer setActive:[command[@"active"] boolValue]
                      generation:[command[@"generation"] unsignedIntegerValue]];
          } else if ([name isEqualToString:@"request-permission"]) {
            [observer requestPermission];
          } else if ([name isEqualToString:@"diagnose"]) {
            [observer emitDiagnosticSnapshot];
          } else if ([name isEqualToString:@"shutdown"]) {
            shutdown();
          }
        }
        endOfInputHandler:shutdown];
    [reader start];

    signal(SIGTERM, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    dispatch_source_t terminateSource = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_t interruptSource = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(terminateSource, shutdown);
    dispatch_source_set_event_handler(interruptSource, shutdown);
    dispatch_resume(terminateSource);
    dispatch_resume(interruptSource);

    CFRunLoopRun();
    [reader stop];
    [observer stop];
    terminateSource = nil;
    interruptSource = nil;
    return 0;
  }
}
