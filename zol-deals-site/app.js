function openDeal(evt, el) {
  evt.preventDefault();
  var url = el.href;
  var asin = el.dataset.asin;
  var ua = navigator.userAgent;
  // Desktop: open Amazon in a new tab
  if (!/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  // Android + ASIN: intent URI — OS picks app or browser automatically
  if (/Android/i.test(ua) && asin) {
    window.location.href =
      'intent://www.amazon.com/dp/' + asin + '?tag=gowns04-20' +
      '#Intent;scheme=https;package=com.amazon.mShop.android.shopping;' +
      'S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
    return;
  }
  // iOS + all other mobile: navigate directly.
  // Amazon's Universal Links open the app if installed; Safari otherwise.
  window.location.href = url;
}