/* Shared tag registry + hover tooltips.
   Single source of truth for the canonical tag list (tags.html,
   all-characters.html, create.html, edit.html all read from here) and the
   short description shown in the hover box on any element with a
   data-tag attribute. */
(function () {
  var TAG_INFO = {
    'Ability Gain': 'Gains an ability during the game, or gives one to another player.',
    'Alignment Change': 'A player’s real alignment changes: good becomes evil or evil becomes good. Only registering as the other alignment is Misregistration.',
    'Binary Info': 'Learns information with only two possible answers: yes or no, true or false, this one or that one.',
    'Character Change': 'A player actually becomes a different character. Gaining another character’s ability without becoming it is Ability Gain.',
    'Confirmation': 'Can confirm itself or others.',
    'Consult': 'The player has to visit or talk with the Storyteller to use the ability.',
    'Day Deaths': 'Causes a player to die during the day by something other than an execution.',
    'Death': 'Mentions death at all: kills players, or cares about players dying or being dead.',
    'Death Modification': 'Bends how death works: deaths that are delayed, moved to another player, ignored, or registered differently.',
    'Demonsbane': 'Its team benefits when this player is killed at night or by the Demon. Never a downside.',
    'Drunkenness': 'Causes drunkenness, or interacts with drunk players.',
    'Even If Dead': 'Keeps working after the player dies, or only works once they are dead.',
    'Execution': 'Causes, prevents, reacts to or mentions executions.',
    'Execution Failure': 'An execution itself fails or cannot happen. Surviving one is Execution Survival.',
    'Execution Survival': 'A player is executed but does not die, including living on while registering as dead.',
    'Extra Evil': 'Adds, or can create, an extra evil player.',
    'False Info': 'Causes or interacts with false info. Being drunk or poisoned does not count on its own.',
    'Duplication': 'More than one of this same character can be in play.',
    'Grim Peeker': 'Shows the Grimoire, or part of it, to any player.',
    'Hidden': 'An Outsider that wants to stay hidden, like the Sweetheart, or doesn’t know it is one, like the Drunk.',
    'Information': 'This character’s own player learns something from their ability. Another player learning about it is Ping.',
    'Joke': ';P',
    'Loud': 'Something everyone in the town knows about, like the Fearmonger.',
    'Madness': 'Creates madness, or interacts with mad players.',
    'Magic': 'Can cause almost anything to happen, or lets the Storyteller break the rules, like the Atheist.',
    'Misregistration': 'Can register as another character, team, or alignment.',
    'Multi-Kill': 'Can kill more than one player in a night. A killer that only sometimes kills two is Multi-Kill, not Single-Kill.',
    'Neighbor': 'Cares about the players sitting next to someone.',
    'Nominations': 'Makes, blocks, reacts to or mentions nominations.',
    'Nonconformist': 'Breaks a core rule, the kind a veteran would say is not how the game works: no Demon, two Demons, an executable Storyteller.',
    'On Death': 'Something happens when a player dies: this one, or another player the ability cares about.',
    'Once Per Game': 'Its ability can only be used once per game.',
    'Outsider Modification': 'Changes the number of Outsiders in play during setup.',
    'Passive': 'Always on: no choices and no waking. Effects that fire by themselves count.',
    'Ping': 'Another player privately learns about this character: that it is in play, who it is, or that it acted. Public reveals are Public, not Ping.',
    'Poison': 'Poisons players, or interacts with poisoning.',
    'Protection': 'Stops a player from dying. Protection from anything other than death does not count.',
    'Public': 'The player does something in front of everyone, like the Gossip.',
    'Quiet': 'An evil character whose work nobody notices, like the Poisoner.',
    'Resurrection': 'Brings a dead player back to life. Never dying in the first place is Death Modification.',
    'Reverse': 'Reverses an effect, a rule, or another character’s ability. Any ability that says “reverse” or “reversed” counts.',
    'Safe': 'Makes a player safe. The word “safe” appears in the ability.',
    'Safety Net': 'Stops the game being won or lost too early, like the Scarlet Woman taking over when the Demon dies.',
    'Setup': 'Changes the game during setup (square-bracket setup text).',
    'Single-Kill': 'Kills one player, each night or once per game, on any team. “A player might die” does not count.',
    'Sober & Healthy': 'Cares about being sober and healthy, or makes a player sober and healthy.',
    'Social': 'Changes how players behave socially: talking, silence, gestures, or who they must interact with.',
    'Subjective Info': 'The Storyteller decides what the information is, rather than a fixed rule.',
    'Think': 'Thinks it is a different character, or makes other players think they are.',
    'Timer': 'A team wins or loses on a set day or night, like “after day 4, evil wins”.',
    'True Info': 'Guarantees true info, or changes whether info is true. Ordinary info does not count.',
    'Votes': 'Interacts with or mentions voting: extra votes, blocked votes, changed counts, vote tokens.',
    'Win/Loss Condition': 'Adds a new way for a player or team to win or lose the game.',
    'You Start Knowing': 'Starts the game knowing something. Any ability that says “start knowing” counts.'
  };

  var KNOWN_TAGS = Object.keys(TAG_INFO).sort();

  // case-insensitive description lookup
  var LOWER = {};
  KNOWN_TAGS.forEach(function (t) { LOWER[t.toLowerCase()] = TAG_INFO[t]; });
  function describeTag(name) {
    return LOWER[String(name || '').trim().toLowerCase()] || '';
  }

  /* Build the create/edit tag-picker buttons from the shared list. */
  function escTag(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function buildTagPicker(container) {
    if (!container) return;
    container.innerHTML = KNOWN_TAGS.map(function (t) {
      return '<button type="button" class="tag-pick-btn" data-tag="' +
        escTag(t) + '">' + escTag(t) + '</button>';
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
  // The Worker reads the descriptions too (the /tag page's first screen is
  // drawn there, worker/list-pages.js), so nothing here touches the DOM
  // unless there is one.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
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
  }

  if (typeof window !== 'undefined') {
    window.TAG_INFO = TAG_INFO;
    window.KNOWN_TAGS = KNOWN_TAGS;
    window.describeTag = describeTag;
    window.buildTagPicker = buildTagPicker;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TAG_INFO: TAG_INFO, KNOWN_TAGS: KNOWN_TAGS, describeTag: describeTag };
  }
})();
