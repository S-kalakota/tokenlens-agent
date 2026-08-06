#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^TLMessageHandler)(NSDictionary *message);

@interface TLAccessibilityObserver : NSObject

- (instancetype)initWithMessageHandler:(TLMessageHandler)messageHandler;
- (void)setActive:(BOOL)active generation:(NSUInteger)generation;
- (void)requestPermission;
- (void)emitDiagnosticSnapshot;
- (void)stop;

@end

NS_ASSUME_NONNULL_END
