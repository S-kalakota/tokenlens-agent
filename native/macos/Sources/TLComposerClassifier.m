#import "TLComposerClassifier.h"

NSString *const TLCursorBundleIdentifier = @"com.todesktop.230313mzl4w4u92";
const NSUInteger TLMaximumDiagnosticStringLength = 1024;
const NSUInteger TLMaximumDiagnosticParentDepth = 8;
const NSUInteger TLMaximumDiagnosticClassCount = 32;
const NSUInteger TLMaximumDiagnosticAttributeCount = 96;

NSString *TLSanitizeDiagnosticString(NSString *value) {
  if (![value isKindOfClass:NSString.class]) return @"";
  if (value.length <= TLMaximumDiagnosticStringLength) return value;

  NSUInteger length = TLMaximumDiagnosticStringLength;
  if (length > 0 && length < value.length &&
      CFStringIsSurrogateHighCharacter([value characterAtIndex:length - 1]) &&
      CFStringIsSurrogateLowCharacter([value characterAtIndex:length])) {
    length -= 1;
  }
  return [value substringToIndex:length];
}

NSArray<NSString *> *TLSanitizeDiagnosticStringArray(
    NSArray *values, NSUInteger maximumCount) {
  if (![values isKindOfClass:NSArray.class] || maximumCount == 0) return @[];
  NSMutableArray<NSString *> *strings = [NSMutableArray array];
  for (id item in values) {
    if ([item isKindOfClass:NSString.class]) {
      [strings addObject:TLSanitizeDiagnosticString(item)];
      if (strings.count == maximumCount) break;
    }
  }
  return strings;
}

static NSString *TLStringAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef rawValue = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &rawValue) != kAXErrorSuccess ||
      rawValue == NULL) {
    return @"";
  }

  id value = CFBridgingRelease(rawValue);
  return [value isKindOfClass:NSString.class]
      ? TLSanitizeDiagnosticString(value) : @"";
}

static NSArray<NSString *> *TLStringArrayAttribute(AXUIElementRef element,
                                                   CFStringRef attribute,
                                                   NSUInteger maximumCount) {
  CFTypeRef rawValue = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &rawValue) != kAXErrorSuccess ||
      rawValue == NULL) {
    return @[];
  }
  id value = CFBridgingRelease(rawValue);
  return [value isKindOfClass:NSArray.class]
      ? TLSanitizeDiagnosticStringArray(value, maximumCount) : @[];
}

static BOOL TLSupportsValueAttribute(AXUIElementRef element) {
  CFArrayRef rawNames = NULL;
  if (AXUIElementCopyAttributeNames(element, &rawNames) != kAXErrorSuccess || rawNames == NULL) {
    return NO;
  }

  NSArray *names = CFBridgingRelease(rawNames);
  return [names containsObject:(__bridge NSString *)kAXValueAttribute];
}

static NSArray<NSString *> *TLSupportedAttributeNames(AXUIElementRef element) {
  CFArrayRef rawNames = NULL;
  if (AXUIElementCopyAttributeNames(element, &rawNames) != kAXErrorSuccess ||
      rawNames == NULL) {
    return @[];
  }
  NSArray *names = CFBridgingRelease(rawNames);
  NSMutableArray<NSString *> *strings = [NSMutableArray array];
  for (id name in names) {
    if ([name isKindOfClass:NSString.class]) {
      [strings addObject:TLSanitizeDiagnosticString(name)];
    }
  }
  NSArray<NSString *> *sorted =
      [strings sortedArrayUsingSelector:@selector(compare:)];
  return sorted.count <= TLMaximumDiagnosticAttributeCount
      ? sorted
      : [sorted subarrayWithRange:NSMakeRange(
            0, TLMaximumDiagnosticAttributeCount)];
}

static NSDictionary *TLMetadataForElement(AXUIElementRef element) {
  return @{
    @"role" : TLStringAttribute(element, kAXRoleAttribute),
    @"subrole" : TLStringAttribute(element, kAXSubroleAttribute),
    @"identifier" : TLStringAttribute(element, kAXIdentifierAttribute),
    @"domIdentifier" : TLStringAttribute(element, CFSTR("AXDOMIdentifier")),
    @"domClasses" : TLStringArrayAttribute(
        element, CFSTR("AXDOMClassList"), TLMaximumDiagnosticClassCount),
  };
}

BOOL TLIsAllowedCursorBundleIdentifier(NSString *bundleIdentifier) {
  return [bundleIdentifier isEqualToString:TLCursorBundleIdentifier];
}

BOOL TLMetadataLooksLikeCursorComposer(NSDictionary *snapshot) {
  if (![snapshot isKindOfClass:NSDictionary.class] ||
      ![snapshot[@"valueAttributeSupported"] isEqual:@YES]) {
    return NO;
  }

  NSString *role = [snapshot[@"role"] isKindOfClass:NSString.class] ? snapshot[@"role"] : @"";
  if (![role isEqualToString:(__bridge NSString *)kAXTextAreaRole] &&
      ![role isEqualToString:(__bridge NSString *)kAXTextFieldRole]) {
    return NO;
  }

  NSArray *directClasses = [snapshot[@"domClasses"] isKindOfClass:NSArray.class]
      ? snapshot[@"domClasses"] : @[];
  BOOL hasCursorEditorInputClass = [directClasses containsObject:@"aislash-editor-input"];
  NSArray *parents = [snapshot[@"parents"] isKindOfClass:NSArray.class]
      ? snapshot[@"parents"] : @[];
  BOOL hasComposerAncestor = NO;
  for (id parent in parents) {
    if (![parent isKindOfClass:NSDictionary.class]) continue;
    NSArray *classes = [parent[@"domClasses"] isKindOfClass:NSArray.class]
        ? parent[@"domClasses"] : @[];
    if ([classes containsObject:@"composer-input-blur-wrapper"] ||
        [classes containsObject:@"ai-input-full-input-box"] ||
        [classes containsObject:@"composer-bar"]) {
      hasComposerAncestor = YES;
      break;
    }
  }
  return hasCursorEditorInputClass && hasComposerAncestor;
}

static NSDictionary *TLSnapshotForElement(AXUIElementRef element,
                                          NSUInteger maximumParentDepth,
                                          BOOL includeAttributeNames) {
  maximumParentDepth = MIN(
      maximumParentDepth, TLMaximumDiagnosticParentDepth);
  NSMutableDictionary *snapshot = [TLMetadataForElement(element) mutableCopy];
  snapshot[@"valueAttributeSupported"] =
      [NSNumber numberWithBool:TLSupportsValueAttribute(element)];
  if (includeAttributeNames) {
    snapshot[@"attributeNames"] = TLSupportedAttributeNames(element);
  }

  NSMutableArray<NSDictionary *> *parents = [NSMutableArray array];
  AXUIElementRef current = element;
  if (current != NULL) CFRetain(current);

  for (NSUInteger depth = 0; current != NULL && depth < maximumParentDepth; depth += 1) {
    CFTypeRef rawParent = NULL;
    AXError result = AXUIElementCopyAttributeValue(current, kAXParentAttribute, &rawParent);
    CFRelease(current);
    current = NULL;
    if (result != kAXErrorSuccess || rawParent == NULL ||
        CFGetTypeID(rawParent) != AXUIElementGetTypeID()) {
      if (rawParent != NULL) CFRelease(rawParent);
      break;
    }
    current = (AXUIElementRef)rawParent;
    [parents addObject:TLMetadataForElement(current)];
  }

  if (current != NULL) CFRelease(current);
  snapshot[@"parents"] = parents;
  return snapshot;
}

NSDictionary *TLClassifierSnapshotForElement(AXUIElementRef element,
                                             NSUInteger maximumParentDepth) {
  return TLSnapshotForElement(element, maximumParentDepth, NO);
}

NSDictionary *TLSanitizedSnapshotForElement(AXUIElementRef element,
                                            NSUInteger maximumParentDepth) {
  return TLSnapshotForElement(element, maximumParentDepth, YES);
}
