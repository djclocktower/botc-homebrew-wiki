/* Character page bootstrap — used by every /c/{slug}.html page.
   Reads window.CHAR_SLUG, fetches ../characters.json, renders via render.js. */
(function () {
  var SLUG = window.CHAR_SLUG;
  var content = document.getElementById('content');
  if (!content || !SLUG) return;

  var SCRIPT_KEY = 'botc_script';
  function getScript() { try { return JSON.parse(localStorage.getItem(SCRIPT_KEY)) || []; } catch (e) { return []; } }
  function setScript(a) { try { localStorage.setItem(SCRIPT_KEY, JSON.stringify(a)); } catch (e) {} }
  function mountScriptButton(slug) {
    var infocard = document.querySelector('.char-infocard');
    if (!infocard) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-to-script-btn';
    function sync() {
      var on = getScript().indexOf(slug) !== -1;
      btn.classList.toggle('on', on);
      btn.textContent = on ? '✓ On Your Script' : '+ Add to Script';
    }
    btn.addEventListener('click', function () {
      var s = getScript();
      var i = s.indexOf(slug);
      if (i === -1) s.push(slug); else s.splice(i, 1);
      setScript(s);
      sync();
      if (window.updateScriptBadge) window.updateScriptBadge();
    });
    sync();
    infocard.appendChild(btn);
  }

  var TOKEN_KEY = 'botc_token_set';
  function getTokenSet() { try { return JSON.parse(localStorage.getItem(TOKEN_KEY)) || []; } catch (e) { return []; } }
  function setTokenSet(a) { try { localStorage.setItem(TOKEN_KEY, JSON.stringify(a)); } catch (e) {} }
  function mountTokenButton(slug) {
    var infocard = document.querySelector('.char-infocard');
    if (!infocard) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'add-to-script-btn add-to-token-btn';
    function sync() {
      var on = getTokenSet().indexOf(slug) !== -1;
      btn.classList.toggle('on', on);
      btn.textContent = on ? '\u2713 In Token Tool' : '+ Add to Token Tool';
    }
    btn.addEventListener('click', function () {
      var s = getTokenSet(); var i = s.indexOf(slug);
      if (i === -1) s.push(slug); else s.splice(i, 1);
      setTokenSet(s); sync();
    });
    sync();
    infocard.appendChild(btn);
  }

  if (window.SSR) {
    var eb0 = document.getElementById('edit-btn');
    if (eb0) { eb0.href = (window.LINK_ROOT || '') + 'edit?c=' + SLUG; eb0.style.display = ''; }
    mountScriptButton(SLUG);
    mountTokenButton(SLUG);
    if (window.fitCharTitle) window.fitCharTitle();
    if (location.hash) {
      var t0 = document.getElementById(location.hash.slice(1));
      if (t0) t0.scrollIntoView();
    }
    return;
  }

  fetch('../characters.json?_=' + Date.now())
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var d = list.filter(function (c) { return c.slug === SLUG; })[0];
      if (!d) {
        content.innerHTML = '<p style="color:rgba(236,225,200,.8);text-align:center;padding:40px">Character not found. <a href="../all-characters.html" style="color:#7fb2e6">Back to all characters</a>.</p>';
        return;
      }
      document.title = d.name + ' — BOTC HomeBrew Wiki';
      var label = (window.TEAM_LABEL[d.team] || d.team);
      var crumb = document.getElementById('crumb');
      if (crumb) crumb.innerHTML =
        '<a href="../">Home</a><span class="sep">›</span><a href="../all-characters">Characters</a><span class="sep">·</span><a href="../script">Script Builder</a><span class="sep">·</span><a href="../tokens">Token Tool</a><span class="sep">›</span>' +
        '<a href="../team?t=' + d.team + '">' + label + '</a>' +
        '<span class="sep">›</span><span class="here">' + d.name + '</span>';
      var eb = document.getElementById('edit-btn');
      if (eb) { eb.href = '../edit?c=' + SLUG; eb.style.display = ''; }
      var artSrc = d.art ? '../assets/' + d.art
        : (Array.isArray(d.image) ? d.image[0] : d.image) || '';
      content.innerHTML = window.renderCharacter(d, artSrc);
      mountScriptButton(d.slug);
      mountTokenButton(d.slug);
      if (window.fitCharTitle) window.fitCharTitle();
      if (location.hash) {
        var t = document.getElementById(location.hash.slice(1));
        if (t) t.scrollIntoView();
      }
    })
    .catch(function () {
      content.innerHTML = '<p style="color:#e6a">Could not load character data.</p>';
    });
})();
