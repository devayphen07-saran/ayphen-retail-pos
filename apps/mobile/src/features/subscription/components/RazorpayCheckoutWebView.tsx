/**
 * Razorpay Standard Checkout via WebView, not the native SDK (subscription.md
 * §9). The backend already creates a plain Razorpay Order over REST — this
 * component just renders Razorpay's own hosted `checkout.js` inside a WebView,
 * initialized with the fields the checkout mutation returned, and bridges the
 * three outcomes (success / dismiss / failed) back to React Native via
 * `window.ReactNativeWebView.postMessage`.
 */
import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useMobileTheme } from '@ayphen/mobile-theme';
import { Typography } from '@ayphen/mobile-ui-components';

export interface RazorpaySuccessPayload {
  razorpay_order_id:   string;
  razorpay_payment_id: string;
  razorpay_signature:  string;
}

export interface RazorpayCheckoutWebViewProps {
  keyId:    string;
  orderId:  string;
  amount:   number; // paise
  currency: string;
  prefill:  { name: string; contact: string };
  onSuccess: (payload: RazorpaySuccessPayload) => void;
  onDismiss: () => void;
  onFailure: (reason: string | undefined) => void;
}

function buildCheckoutHtml(opts: Pick<RazorpayCheckoutWebViewProps, 'keyId' | 'orderId' | 'amount' | 'currency' | 'prefill'>): string {
  const options = {
    key:      opts.keyId,
    amount:   opts.amount,
    currency: opts.currency,
    order_id: opts.orderId,
    name:     'Ayphen Retail',
    prefill:  opts.prefill,
  };
  // JSON.stringify is safe here — every field is either a string/number we
  // control (from our own backend response) or the object literal above;
  // nothing here is raw unescaped user input concatenated into the script.
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#fff;">
<script>
  function post(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  // If checkout.js itself fails to load (offline, CDN blocked) the WebView's
  // main frame still loaded fine, so RN's onError never fires — the script tag's
  // own onerror is the only signal. Surface it as a failure instead of leaving
  // the user on a blank white page.
  function onScriptError() {
    post({ type: 'failed', reason: "Couldn't load the payment page. Check your connection and try again." });
  }
</script>
<script src="https://checkout.razorpay.com/v1/checkout.js" onerror="onScriptError()"></script>
<script>
  try {
    if (typeof Razorpay === 'undefined') { onScriptError(); } else {
      var options = ${JSON.stringify(options)};
      options.handler = function (response) {
        post({
          type: 'success',
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        });
      };
      options.modal = {
        ondismiss: function () { post({ type: 'dismiss' }); },
      };
      var rzp = new Razorpay(options);
      rzp.on('payment.failed', function (response) {
        post({
          type: 'failed',
          reason: response && response.error ? response.error.description : undefined,
        });
      });
      rzp.open();
    }
  } catch (e) {
    post({ type: 'failed', reason: 'Something went wrong starting the payment.' });
  }
</script>
</body>
</html>`;
}

export function RazorpayCheckoutWebView({
  onSuccess,
  onDismiss,
  onFailure,
  ...opts
}: RazorpayCheckoutWebViewProps) {
  const html = useMemo(
    () => buildCheckoutHtml(opts),
    [opts.keyId, opts.orderId, opts.amount, opts.currency, opts.prefill.name, opts.prefill.contact],
  );

  const handleMessage = (event: WebViewMessageEvent) => {
    let msg: { type?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return; // malformed bridge message — ignore rather than crash the screen
    }

    if (msg.type === 'success') {
      onSuccess({
        razorpay_order_id:   String(msg.razorpay_order_id ?? ''),
        razorpay_payment_id: String(msg.razorpay_payment_id ?? ''),
        razorpay_signature:  String(msg.razorpay_signature ?? ''),
      });
    } else if (msg.type === 'dismiss') {
      onDismiss();
    } else if (msg.type === 'failed') {
      onFailure(typeof msg.reason === 'string' ? msg.reason : undefined);
    }
  };

  return (
    <WebView
      originWhitelist={['*']}
      source={{ html }}
      onMessage={handleMessage}
      javaScriptEnabled
      domStorageEnabled
      style={{ flex: 1 }}
      // Cover the gap between the WebView mounting and Razorpay's hosted
      // checkout rendering — without this the user stares at a blank white
      // page while checkout.js downloads over the network (loading-agent.md §4).
      startInLoadingState
      renderLoading={() => <CheckoutWebViewLoading />}
      // Defence for main-frame load/HTTP failures (checkout.js subresource
      // failures are handled by the script's own onerror in the HTML above).
      onError={() => onFailure("Couldn't load the payment page. Check your connection and try again.")}
      onHttpError={() => onFailure("Couldn't load the payment page. Please try again.")}
    />
  );
}

/** Splash for the WebView's own load — shown until Razorpay's hosted checkout
 *  paints, so the payment screen never flashes blank white. */
function CheckoutWebViewLoading() {
  const { theme } = useMobileTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.loading, { backgroundColor: theme.colorBgContainer }]}>
      <ActivityIndicator size="large" color={theme.color.primary.main} />
      <Typography.Caption color={theme.colorTextSecondary}>Loading secure checkout…</Typography.Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
});
