function openDeal(evt, el) {
  evt.preventDefault();
  var url = el.href;
  var asin = el.dataset.asin;
  var ua = navigator.userAgent;
  if (!asin || !/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    var t = setTimeout(function() { window.open(url, '_blank', 'noopener'); }, 2000);
    document.addEventListener('visibilitychange', function h() {
      if (document.hidden) {
        clearTimeout(t);
        document.removeEventListener('visibilitychange', h);
      }
    });
    window.location.href = 'amzn://dp/' + asin + '?tag=gowns04-20';
  } else {
    window.location.href =
      'intent://www.amazon.com/dp/' + asin + '?tag=gowns04-20' +
      '#Intent;scheme=https;package=com.amazon.mShop.android.shopping;' +
      'S.browser_fallback_url=' + encodeURIComponent(url) + ';end';
  }
}