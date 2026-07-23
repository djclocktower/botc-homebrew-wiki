/* Shared tag registry + hover tooltips.
   Single source of truth for the canonical tag list (tags.html,
   all-characters.html, create.html, edit.html all read from here) and the
   short description shown in the hover box on any element with a
   data-tag attribute. */
(function () {
  var TAG_INFO = {
    'Alignment Change': 'Can change a player’s alignment, or make good and evil players swap sides.',
    'Character Change': 'Can change a player’s character, or become another character itself.',
    'Consult': 'Privately visits the Storyteller to ask questions or make decisions.',
    'Death': 'Kills players, or cares about players dying.',
    'Death Modification': 'Changes how, when, or whether deaths happen.',
    'Drunkenness': 'Causes drunkenness, or interacts with drunk players.',
    'Even If Dead': 'Its ability keeps working (fully or partly) after the player dies.',
    'Execution': 'Interacts with executions — causing, preventing, or reacting to them.',
    'Execution Survival': 'Can survive execution, or lets another player survive one.',
    'Duplication': 'Copies itself — extra copies of this character can be in play.',
    'Hidden': 'Hides its presence, identity, or other game information from players.',
    'Information': 'The player learns something from their ability.',
    'Loss Condition': 'Adds a new way for a player or team to lose the game.',
    'Loud': 'Announces information or effects publicly to the whole town.',
    'Madness': 'Creates madness, or interacts with mad players.',
    'Misregistration': 'Can register as another character, team, or alignment.',
    'Multi-Kill': 'An evil character that can kill more than one player per night.',
    'Neighbor': 'Cares about the players sitting next to someone.',
    'Nominations': 'Interacts with nominations — making, blocking, or reacting to them.',
    'Nonconformist': 'Breaks a core rule or convention of the game.',
    'On Death': 'Something happens when this player dies.',
    'Once Per Game': 'Its ability can only be used once per game.',
    'Outsider Modification': 'Changes the number of Outsiders in play during setup.',
    'Passive': 'Always-on ability — no choices or actions needed from the player.',
    'Ping': 'One player learns that this character is in play (Widow / Lunatic style).',
    'Poison': 'Poisons players, or interacts with poisoning.',
    'Protection': 'Protects players from death or other harm.',
    'Public': 'Uses or reveals its ability publicly, in front of everyone.',
    'Quiet': 'Leaves little or no public evidence that its ability happened.',
    'Resurrection': 'Can bring dead players back to life.',
    'Reverse': 'Reverses an effect, a rule, or another character’s ability.',
    'Safe': 'Makes a player safe — the word “safe” appears in the ability.',
    'Safety Net': 'Protects a team or the game from a worst-case outcome.',
    'Setup': 'Changes the game during setup (square-bracket setup text).',
    'Single-Kill': 'An evil character that kills one player per night.',
    'Social': 'Affects how players talk, behave, or interact with each other.',
    'Think': 'Characters that think or make other players think they are different characters.',
    'Timer': 'Adds a time limit or countdown to the game.',
    'Votes': 'Interacts with voting — extra votes, blocked votes, or changed counts.',
    'Win Condition': 'Adds a new way for a player or team to win the game.',
    'You Start Knowing': 'Starts the game knowing information from their ability.'
  };

  var KNOWN_TAGS = Object.keys(TAG_INFO).sort();

  // case-insensitive description lookup
  var LOWER = {};
  KNOWN_TAGS.forEach(function (t) { LOWER[t.toLowerCase()] = TAG_INFO[t]; });
  function describeTag(name) {
    return LOWER[String(name || '').trim().toLowerCase()] || '';
  }

  /* Build the create/edit tag-picker buttons from the shared list. */
  function buildTagPicker(container) {
    if (!container) return;
    container.innerHTML = KNOWN_TAGS.map(function (t) {
      return '<button type="button" class="tag-pick-btn" data-tag="' +
        t.replace(/"/g, '&quot;') + '">' + t + '</button>';
    }).join('');
  }

  /* ── hover box: shows the description for any element with data-tag ── */
  var tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'tag-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(el, text) {
    var t = ensureTip();
    t.textContent = text;
    t.hidden = false;
    // measure, then position under the element (clamped to the viewport)
    var r = el.getBoundingClientRect();
    t.style.left = '0px'; t.style.top = '0px';
    var tw = t.offsetWidth, th = t.offsetHeight;
    var x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    var y = r.bottom + 8;
    if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    t.style.left = Math.round(x) + 'px';
    t.style.top = Math.round(y) + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function tagEl(target) {
    if (!target || !target.closest) return null;
    var el = target.closest('[data-tag]');
    if (!el) return null;
    return describeTag(el.getAttribute('data-tag')) ? el : null;
  }
  document.addEventListener('mouseover', function (e) {
    var el = tagEl(e.target);
    if (el) showTip(el, describeTag(el.getAttribute('data-tag')));
    else hideTip();
  });
  document.addEventListener('focusin', function (e) {
    var el = tagEl(e.target);
    if (el) showTip(el, describeTag(el.getAttribute('data-tag')));
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

  window.TAG_INFO = TAG_INFO;
  window.KNOWN_TAGS = KNOWN_TAGS;
  window.describeTag = describeTag;
  window.buildTagPicker = buildTagPicker;
})();
