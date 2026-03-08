function openDeal(evt, el) {
  var url = el.href;
  var asin = el.dataset.asin;
  var ua = navigator.userAgent;

  // iOS: return WITHOUT calling preventDefault so the native <a> tap proceeds.
  // iOS intercepts amazon.com Universal Links BEFORE the browser navigates —
  // but ONLY if the tap event hasn't been cancelled. Calling preventDefault()
  // here kills the event and the app never opens.
  if (/iPhone|iPad|iPod/i.test(ua)) return;

  // Everything else needs preventDefault so we can control the navigation.
  evt.preventDefault();

  // Desktop: open Amazon in a new tab as normal
  if (!/Mobi|Android/i.test(ua)) {
    window.open(url, '_blank', 'noopener');
    return;
  }

  // Android + ASIN: intent URI routes directly to the Amazon app.
  // browser_fallback_url handles "app not installed" gracefully.
  if (asin) {
    window.location.href =
      'intent://www.amazon.com/dp/' + asin + '?tag=gowns04-20' +
      '#Intent;scheme=https;package=com.amazon.mShop.android.shopping;' +
      'S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
    return;
  }

  // Android without an extractable ASIN: fall back to plain navigation
  window.location.href = url;
}