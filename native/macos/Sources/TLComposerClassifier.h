#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *const TLCursorBundleIdentifier;
FOUNDATION_EXPORT const NSUInteger TLMaximumDiagnosticStringLength;
FOUNDATION_EXPORT const NSUInteger TLMaximumDiagnosticParentDepth;
FOUNDATION_EXPORT const NSUInteger TLMaximumDiagnosticClassCount;
FOUNDATION_EXPORT const NSUInteger TLMaximumDiagnosticAttributeCount;

BOOL TLIsAllowedCursorBundleIdentifier(NSString *bundleIdentifier);
BOOL TLMetadataLooksLikeCursorComposer(NSDictionary *snapshot);
NSString *TLSanitizeDiagnosticString(NSString *value);
NSArray<NSString *> *TLSanitizeDiagnosticStringArray(
    NSArray *values, NSUInteger maximumCount);
NSDictionary *TLClassifierSnapshotForElement(AXUIElementRef element,
                                             NSUInteger maximumParentDepth);
NSDictionary *TLSanitizedSnapshotForElement(AXUIElementRef element, NSUInteger maximumParentDepth);

NS_ASSUME_NONNULL_END
