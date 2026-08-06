#import "TLProtocol.h"

#import <math.h>

const NSInteger TLProtocolVersion = 1;
const NSUInteger TLMaximumProtocolLineBytes = 4 * 1024;
const NSUInteger TLMaximumDraftCharacters = 1 * 1000 * 1000;

NSUInteger TLUnicodeScalarCount(NSString *value) {
  NSUInteger count = 0;
  NSUInteger index = 0;
  const NSUInteger length = value.length;

  while (index < length) {
    const unichar unit = [value characterAtIndex:index];
    if (CFStringIsSurrogateHighCharacter(unit) && index + 1 < length) {
      const unichar next = [value characterAtIndex:index + 1];
      if (CFStringIsSurrogateLowCharacter(next)) {
        index += 2;
        count += 1;
        continue;
      }
    }

    index += 1;
    count += 1;
  }

  return count;
}

NSUInteger TLCursorDraftUnicodeScalarCount(NSString *value) {
  // Chromium exposes a single line-break sentinel for an empty contenteditable
  // composer. It disappears as soon as actual content is entered.
  if (value.length == 0 || [value isEqualToString:@"\n"] ||
      [value isEqualToString:@"\r"] || [value isEqualToString:@"\r\n"]) {
    return 0;
  }
  return TLUnicodeScalarCount(value);
}

BOOL TLDictionaryHasExactKeys(NSDictionary *dictionary, NSSet<NSString *> *keys) {
  if (dictionary.count != keys.count) {
    return NO;
  }
  for (id key in dictionary) {
    if (![key isKindOfClass:NSString.class] || ![keys containsObject:key]) {
      return NO;
    }
  }
  return YES;
}

static BOOL TLIsSafeSequenceNumber(id value) {
  if (![value isKindOfClass:NSNumber.class] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  const double number = [value doubleValue];
  return isfinite(number) && number >= 0.0 && number <= 9007199254740991.0 &&
      floor(number) == number;
}

NSDictionary *TLParseCommand(NSData *lineData, NSString **errorCode) {
  if (lineData.length == 0 ||
      lineData.length > TLMaximumProtocolLineBytes - 1) {
    if (errorCode != NULL) *errorCode = @"invalid-command-size";
    return nil;
  }

  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:lineData options:0 error:&error];
  if (error != nil || ![value isKindOfClass:NSDictionary.class]) {
    if (errorCode != NULL) *errorCode = @"invalid-command-json";
    return nil;
  }

  NSDictionary *command = value;
  if (!TLIsSafeSequenceNumber(command[@"version"]) ||
      [command[@"version"] doubleValue] != (double)TLProtocolVersion ||
      ![command[@"command"] isKindOfClass:NSString.class]) {
    if (errorCode != NULL) *errorCode = @"invalid-command-schema";
    return nil;
  }

  NSString *name = command[@"command"];
  if ([name isEqualToString:@"set-active"]) {
    if (!TLDictionaryHasExactKeys(command, [NSSet setWithArray:@[
          @"version", @"command", @"active", @"generation"
        ]]) ||
        ![command[@"active"] isKindOfClass:NSNumber.class] ||
        CFGetTypeID((__bridge CFTypeRef)command[@"active"]) != CFBooleanGetTypeID() ||
        !TLIsSafeSequenceNumber(command[@"generation"])) {
      if (errorCode != NULL) *errorCode = @"invalid-command-schema";
      return nil;
    }
    return command;
  }

  if ([name isEqualToString:@"request-permission"] ||
      [name isEqualToString:@"diagnose"] ||
      [name isEqualToString:@"shutdown"]) {
    if (!TLDictionaryHasExactKeys(command, [NSSet setWithArray:@[@"version", @"command"]])) {
      if (errorCode != NULL) *errorCode = @"invalid-command-schema";
      return nil;
    }
    return command;
  }

  if (errorCode != NULL) *errorCode = @"unknown-command";
  return nil;
}

NSData *TLSerializeMessage(NSDictionary *message, NSString **errorCode) {
  if (![NSJSONSerialization isValidJSONObject:message]) {
    if (errorCode != NULL) *errorCode = @"invalid-output-message";
    return nil;
  }

  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:message options:0 error:&error];
  if (error != nil || json.length + 1 > TLMaximumProtocolLineBytes) {
    if (errorCode != NULL) *errorCode = @"output-message-too-large";
    return nil;
  }

  NSMutableData *line = [json mutableCopy];
  const uint8_t newline = '\n';
  [line appendBytes:&newline length:1];
  return line;
}
