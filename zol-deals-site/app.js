function openDeal(evt, el) {
  evt.preventDefault();
  var url = el.href;
  var asin = el.dataset.asin;
  var ua = navigator.userAgent;
  if (!/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  if (/Android/i.test(ua) && asin) {
    // Android: Intent URI opens the Amazon app directly; browser_fallback_url
    // handles the case where the app isn't installed.
    window.location.href =
      'intent://www.amazon.com/dp/' + asin + '?tag=gowns04-20' +
      '#Intent;scheme=https;package=com.amazon.mShop.android.shopping;' +
      'S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
    return;
  }
  // iOS (and Android without ASIN): navigate directly to an amazon.com URL.
  // iOS Universal Links intercept amazon.com URLs and open the Amazon app when
  // it is installed — no custom scheme needed, no dialog, no timer.
  window.location.href = asin
    ? 'https://www.amazon.com/dp/' + asin + '?tag=gowns04-20'
    : url;
}

(function() {
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
  var btn = document.createElement('button');
  btn.className = 'phone-btn';
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/></svg> Continue on Phone';
  btn.onclick = function() {
    var url = window.location.href;
    var overlay = document.createElement('div');
    overlay.className = 'qr-overlay';
    overlay.innerHTML =
      '<div class="qr-box">' +
        '<button class="qr-close" title="Close">&#x2715;</button>' +
        '<h3>Continue on Your Phone</h3>' +
        '<p>Scan with your phone camera to pick up right where you left off.</p>' +
        '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(url) + '" width="200" height="200" alt="QR code">' +
        '<p class="qr-url">' + url + '</p>' +
      '</div>';
    overlay.querySelector('.qr-close').onclick = function() { overlay.remove(); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  };
  document.body.appendChild(btn);
})();