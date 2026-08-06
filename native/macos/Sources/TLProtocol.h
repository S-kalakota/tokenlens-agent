#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT const NSInteger TLProtocolVersion;
/** Maximum complete JSONL frame size, including its trailing LF. */
FOUNDATION_EXPORT const NSUInteger TLMaximumProtocolLineBytes;
FOUNDATION_EXPORT const NSUInteger TLMaximumDraftCharacters;

NSUInteger TLUnicodeScalarCount(NSString *value);
NSUInteger TLCursorDraftUnicodeScalarCount(NSString *value);
BOOL TLDictionaryHasExactKeys(NSDictionary *dictionary, NSSet<NSString *> *keys);
NSDictionary *_Nullable TLParseCommand(NSData *lineData, NSString *_Nullable *_Nullable errorCode);
NSData *_Nullable TLSerializeMessage(NSDictionary *message, NSString *_Nullable *_Nullable errorCode);

NS_ASSUME_NONNULL_END
