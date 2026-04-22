// ============================================================
// PASS IT FORWARD — SECURITY PATCH v1.2 (CLEAN)
// ============================================================

// ── FIX: XSS — Improved sanitize() ──
// Escapes single quotes and backticks for safe use in onclick handlers
var _origSanitize = sanitize;
sanitize = function(str) {
  if (str === null || str === undefined) return '';
  var d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .replace(/\\/g, '&#92;');
};


// ── FIX: Password change — proper modal instead of prompt() ──
changePassword = async function() {
  if (!currentUser) return showToast("Login first");
  if (!sb || currentUser.id.startsWith('demo-'))
    return showToast("Not available in demo mode");

  var modalHtml =
    '<div id="pw-change-modal" style="display:flex;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:5000;align-items:center;justify-content:center;">' +
      '<div style="background:#0d1526;border:1px solid #2d4f6f;border-radius:16px;padding:1.5rem;width:90%;max-width:400px;">' +
        '<h2 style="color:white;font-size:1.1rem;font-weight:700;margin:0 0 4px;">Change Password</h2>' +
        '<p style="color:#64748b;font-size:0.85rem;margin:0 0 1rem;">Enter your new password below.</p>' +
        '<input id="pw-new" type="password" placeholder="New password (6+ characters)" class="form-input" style="margin-bottom:0.8rem;" autocomplete="new-password">' +
        '<input id="pw-confirm" type="password" placeholder="Confirm new password" class="form-input" style="margin-bottom:1rem;" autocomplete="new-password">' +
        '<button id="pw-submit-btn" style="width:100%;background:#2dd4a0;color:#0d1520;border:none;padding:10px;border-radius:10px;font:700 14px/1 Inter,sans-serif;cursor:pointer;">Update Password</button>' +
        '<button onclick="document.getElementById(\'pw-change-modal\').remove()" style="width:100%;background:transparent;color:#64748b;border:none;padding:8px;cursor:pointer;font-size:0.85rem;margin-top:6px;">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  document.getElementById('pw-submit-btn').onclick = async function() {
    var newPass = document.getElementById('pw-new').value;
    var confirmPass = document.getElementById('pw-confirm').value;
    if (newPass.length < 6) return showToast("Password must be 6+ characters");
    if (newPass !== confirmPass) return showToast("Passwords don't match");

    var result = await sb.auth.updateUser({ password: newPass });
    if (result.error) return showToast("Error: " + result.error.message);

    document.getElementById('pw-change-modal').remove();
    showToast("Password changed!");
  };
};


// ── FIX: shareOnX — use window.open instead of location.href ──
shareOnX = function(text) {
  var url = 'https://x.com/intent/post?text=' + encodeURIComponent(text);
  window.open(url, '_blank', 'noopener,noreferrer');
};


// ── FIX: Input length limits ──
function addMaxLengths() {
  var limits = {
    'opp-title': 200, 'opp-desc': 2000, 'opp-budget': 50, 'opp-location': 100,
    'comm-post-text': 3000, 'comm-new-testimonial': 1000, 'edit-bio': 500,
    'ev-title-inp': 200, 'ev-desc-inp': 1000, 'ev-link-inp': 500,
    'raise-title': 200, 'raise-desc': 2000, 'ad-name': 200, 'ad-what': 200,
    'ad-desc': 2000, 'ad-link': 500, 'forge-title': 200, 'dm-msg-inp': 2000,
    'goal-text': 500, 'fund-note': 200, 'rc-handle': 50, 'rc-note': 200
  };
  Object.keys(limits).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.maxLength = limits[id];
  });
}
if (document.readyState === 'complete') addMaxLengths();
else window.addEventListener('load', addMaxLengths);
setInterval(addMaxLengths, 5000);


// ── FIX: Add noopener to ALL external links ──
function fixAllExternalLinks() {
  document.querySelectorAll('a[target="_blank"]').forEach(function(link) {
    if (!link.rel || !link.rel.includes('noopener')) {
      link.rel = 'noopener noreferrer';
    }
  });
}
if (document.readyState === 'complete') fixAllExternalLinks();
else window.addEventListener('load', fixAllExternalLinks);
setInterval(fixAllExternalLinks, 10000);


// ── FIX: Clear all intervals on logout ──
var _pifIntervals = [];
var _origSetInterval = window.setInterval;
window.setInterval = function() {
  var id = _origSetInterval.apply(window, arguments);
  _pifIntervals.push(id);
  return id;
};

var _origLogout = logout;
logout = async function() {
  _pifIntervals.forEach(function(id) { clearInterval(id); });
  _pifIntervals = [];
  window._presenceStarted = false;
  if (typeof _origLogout === 'function') return _origLogout.call(this);
};


// ── FIX: CSP meta tag ──
if (!document.querySelector('meta[http-equiv="Content-Security-Policy"]')) {
  var meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' cdn.jsdelivr.net cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com cdnjs.cloudflare.com",
    "font-src fonts.gstatic.com cdnjs.cloudflare.com",
    "img-src * data: blob:",
    "connect-src 'self' *.supabase.co wss://*.supabase.co buy.stripe.com api.stripe.com cdn.jsdelivr.net",
    "frame-src buy.stripe.com www.youtube.com",
    "media-src 'self' passitfoward.xyz data:",
  ].join('; ');
  document.head.prepend(meta);
}


// ── FIX: Delete exposed email constants ──
try { delete window.FOUNDER_EMAIL; } catch(e) {}
try { delete window._fe; } catch(e) {}


console.log('%c🔒 Security patch v1.2 loaded', 'color:#10b981;font-weight:700;');
/* =========================================================
   NEXAR Mobile Scroll FABs (v1)
   Two floating buttons (▲ top / ▼ bottom) shown only on
   mobile when NEXAR tab is active. Each hides when you're
   already near that end. Scrolls window (main page scroll).
   ========================================================= */
(function nexarMobileScrollFabs() {
  if (window.__nexarFabsInit) return;
  window.__nexarFabsInit = true;

  var css = document.createElement('style');
  css.id = 'nexar-fab-css';
  css.textContent = [
    '.nexar-fab{position:fixed;right:14px;width:44px;height:44px;',
    'border-radius:50%;background:rgba(8,18,26,0.92);',
    'border:1px solid rgba(52,211,178,0.55);color:#34d3b2;',
    'font-size:16px;font-weight:700;line-height:1;padding:0;',
    'display:none;align-items:center;justify-content:center;',
    'cursor:pointer;z-index:9998;opacity:0;pointer-events:none;',
    'box-shadow:0 4px 14px rgba(0,0,0,0.45),0 0 0 1px rgba(52,211,178,0.08);',
    '-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);',
    'transition:opacity .18s ease, transform .18s ease;font-family:inherit;}',
    '.nexar-fab.on{display:flex;opacity:0.92;pointer-events:auto;}',
    '.nexar-fab:active{transform:scale(0.92);}',
    '#nexar-fab-up{bottom:150px;}',
    '#nexar-fab-down{bottom:96px;}',
    '@media (min-width:769px){.nexar-fab{display:none !important;}}'
  ].join('');
  document.head.appendChild(css);

  var up = document.createElement('button');
  up.id = 'nexar-fab-up';
  up.className = 'nexar-fab';
  up.setAttribute('aria-label', 'Scroll to top');
  up.textContent = '▲';
  up.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  var down = document.createElement('button');
  down.id = 'nexar-fab-down';
  down.className = 'nexar-fab';
  down.setAttribute('aria-label', 'Scroll to bottom');
  down.textContent = '▼';
  down.addEventListener('click', function () {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'smooth'
    });
  });

  document.body.appendChild(up);
  document.body.appendChild(down);

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function isNexarActive() {
    var n = document.getElementById('nexar');
    if (!n) return false;
    if (n.offsetParent === null) return false;
    var cs = getComputedStyle(n);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function update() {
    if (!isMobile() || !isNexarActive()) {
      up.classList.remove('on');
      down.classList.remove('on');
      return;
    }
    var y = window.scrollY || window.pageYOffset || 0;
    var max = (document.documentElement.scrollHeight || 0) - window.innerHeight;
    var nearTop = y < 200;
    var nearBottom = y > max - 200;
    up.classList.toggle('on', !nearTop);
    down.classList.toggle('on', !nearBottom);
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      update();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', update, { passive: true });
  setInterval(update, 600); // catches tab switches without hooking showTab()
  update();
})();
