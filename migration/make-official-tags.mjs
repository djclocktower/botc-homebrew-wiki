#!/usr/bin/env node
/* Writes worker/official-tags.js: the official characters with tags, for the
   tag suggester's examples (worker/autotag.js).

   The tags come from the Chinese official wiki's ability categories
   (角色能力类别总览 on clocktower-wiki.gstonegames.com): each category page
   lists the official characters in it, and CATEGORY_TAGS below says which
   wiki tag a category is. They do not map one to one, so a category with no
   clear wiki tag is left out rather than guessed at, and a character keeps
   only the tags its categories give it. The English ability and team come
   from assets/roles.json; a category page names characters in Chinese, and
   each character's own page starts with its icon file, named by its id
   (monk.png), which is how the two are matched. Characters only in the
   Chinese edition match nothing in roles.json; the ones this wiki has a
   page for (Temple Fair and The Storm Is Coming, filed under Festival of
   Lanterns) are matched by hand in WIKI_PAGES instead, and their tags are
   added to those pages' own when the suggester shows them as examples.

   Re-run when either side changes:
     NODE_USE_ENV_PROXY=1 node migration/make-official-tags.mjs
   (the proxy flag is only needed where outbound traffic goes through one). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = 'https://clocktower-wiki.gstonegames.com/index.php?action=raw&title=';
const INDEX = '角色能力类别总览';

// Category -> wiki tag(s). Left out, because no wiki tag is the same idea:
// 回溯型能力 (learns about the past), 影响, 持续检测型能力 (ongoing checks),
// 更换选择目标 (changes a choice), 能力效果干扰 (interferes with abilities),
// 进场能力 (acts on entering play).
const CATEGORY_TAGS = {
  '中毒': ['Poison'], '互动干扰': ['Misregistration'], '保护': ['Protection'],
  '免死': ['Death Modification'], '公开触发能力': ['Public'], '处决': ['Execution'],
  '复活': ['Resurrection'], '投票': ['Votes'], '拜访说书人': ['Consult'],
  '提名': ['Nominations'], '暴露角色': ['Ping'], '死亡触发能力': ['On Death'],
  '死后能力保留': ['Even If Dead'], '特殊胜利失败条件': ['Win/Loss Condition'],
  '疯狂': ['Madness'], '获取信息': ['Information'], '获得能力': ['Ability Gain'],
  '角色变化': ['Character Change'], '认知覆盖': ['Think'], '设置调整': ['Setup'],
  '邻近': ['Neighbor'], '醉酒': ['Drunkenness'], '阵营转变': ['Alignment Change'],
  // "Limited uses": twice per game is in it too, which is not Once Per Game.
  '限次能力': ['Once Per Game'],
  // Extra deaths beyond the Demon's. Death on this wiki is any death in the
  // wording, which the suggester's own rules already add.
  '额外死亡': ['Death'],
};

// Chinese-edition characters -> this wiki's identity for the same character.
// Temple Fair (华灯初上) and The Storm Is Coming (山雨欲来), matched by hand.
const WIKI_PAGES = {
  '书生': 'pedant', '使节': 'ambassador', '养蛊人': 'bug-keeper', '半仙': 'ban-xian', '变脸师': 'face-changer',
  '叫花子': 'pauper', '和尚': 'abbot', '店小二': 'waiter', '悟道者': 'enlightened-one', '戏子': 'actor',
  '打更人': 'firewatcher', '梼杌': 'tao-wu', '歌伶': 'singer', '混沌': 'hun-dun', '煞星': 'lummox',
  '熊孩子': 'rascal', '狐媚娘': 'vixen', '禁卫军': 'imperialist', '穷奇': 'qiong-qi', '赶尸人': 'corpse-walker',
  '逆臣': 'turncoat', '郎中': 'herb-doctor', '钦天监': 'stargazer', '锦衣卫': 'brocadier', '阴阳师': 'yinyang-diviner',
  '饕餮': 'tao-tie', '麒麟': 'qilin',
  '入殓师': 'embalmer', '典狱长': 'warden', '奸佞': 'conspirator', '姑获鸟': 'guhuo', '孟婆': 'meng-po',
  '宠妃': 'consort', '巡察': 'patrol', '引路人': 'guide', '掮客': 'broker', '提刑官': 'prosecutor',
  '方士': 'thaumaturge', '暴君': 'tyrant', '狸猫': 'tabby', '画皮': 'huapi', '知府': 'prefect',
  '秉笔': 'brush-holder', '蛊雕': 'gu-diao', '道士': 'cleric', '酒保': 'server', '酿酒师': 'vintner',
  '驿使': 'courier', '鸩': 'zhen', '赦令承旨': 'messenger', '戏子（改）': 'actor-tsic',
};

async function raw(title) {
  for (let tries = 0; ; tries++) {
    try {
      const res = await fetch(WIKI + encodeURIComponent(title));
      if (res.ok) return await res.text();
      if (res.status === 404) return '';
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (tries >= 3) throw new Error(title + ': ' + e.message);
      await new Promise(r => setTimeout(r, 1000 * (tries + 1)));
    }
  }
}
const links = s => [...s.matchAll(/\[\[([^\]|]+)/g)].map(m => m[1].trim());

const roles = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/roles.json'), 'utf8'));
const byId = new Map(roles.map(r => [r.id, r]));

const members = {};
for (const cat of links(await raw(INDEX))) {
  if (!CATEGORY_TAGS[cat]) continue;
  const page = await raw(cat);
  const at = page.indexOf('相关角色');          // the "related characters" list
  members[cat] = at < 0 ? [] : links(page.slice(at)).filter(n => n !== INDEX);
}

const names = [...new Set(Object.values(members).flat())];
const idOf = new Map();
for (let i = 0; i < names.length; i += 6) {      // a few at a time, to be polite
  await Promise.all(names.slice(i, i + 6).map(async n => {
    const f = (await raw(n)).match(/\[\[(?:File|文件):([^|\]]+)/);
    const id = f && f[1].trim().toLowerCase().replace(/\.(png|jpe?g|webp)$/, '').replace(/[\s_-]/g, '');
    if (id && byId.has(id)) idOf.set(n, id);
  }));
}

const tags = new Map(), wikiTags = new Map();
for (const [cat, list] of Object.entries(members)) {
  for (const n of list) {
    // The wiki page's ability is not to hand here, so "limited uses" is kept
    // and the suggester drops Once Per Game where the ability says no "once".
    const slug = !idOf.has(n) && WIKI_PAGES[n];
    if (slug) { CATEGORY_TAGS[cat].forEach(t => (wikiTags.get(slug) || wikiTags.set(slug, new Set()).get(slug)).add(t)); continue; }
    const id = idOf.get(n); if (!id) continue;
    for (const t of CATEGORY_TAGS[cat]) {
      if (t === 'Once Per Game' && !/\bonce\b/i.test(byId.get(id).ability)) continue;
      (tags.get(id) || tags.set(id, new Set()).get(id)).add(t);
    }
  }
}

const rows = [...tags].sort((a, b) => a[0].localeCompare(b[0])).map(([id, set]) => {
  const r = byId.get(id);
  return { id, name: r.name, team: r.team, ability: r.ability, tags: [...set].join(', ') };
});
const out = '/* Generated by migration/make-official-tags.mjs from the Chinese official\n' +
  '   wiki\'s ability categories and assets/roles.json. Do not edit by hand. */\n' +
  'export const OFFICIAL_TAGGED = ' + JSON.stringify(rows, null, 1) + ';\n\n' +
  '// Chinese-edition characters this wiki has a page for: identity -> official tags.\n' +
  'export const OFFICIAL_WIKI_TAGS = ' + JSON.stringify(Object.fromEntries([...wikiTags].sort()
    .map(([s, set]) => [s, [...set].join(', ')])), null, 1) + ';\n';
fs.writeFileSync(path.join(ROOT, 'worker/official-tags.js'), out);
console.log(rows.length + ' official characters tagged, from ' + Object.keys(members).length +
  ' categories, and ' + wikiTags.size + ' wiki pages of the Chinese edition; ' +
  (names.length - idOf.size - wikiTags.size) + ' names matched neither.');
