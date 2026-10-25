"""Find the gaps in the wiki's character space, and score new ideas against it.

  python3 novelty.py gaps            scrape, embed, find sparse spots -> candidates.json
  python3 novelty.py score ideas.json   rank written-up ideas by distance -> IDEAS.md

Needs: pip install model2vec numpy   (model2vec is a small static embedder,
no torch). The corpus is the live wiki's published characters plus the
official roster, so an idea has to be unlike both.

A character is one vector: ability text, style (quote + flavour lede), tags
(multi-hot) and team (one-hot), each L2-normalised and weighted. A gap is a
point between two same-team characters, jittered, whose nearest real
neighbours are far away. Embeddings cannot be decoded into prose, so a gap is
decoded into what CAN be read off it (team, the tags its tag block lights up,
the ability clauses and quotes nearest to it, the characters to steer clear
of); a person or model writes the character from that, and `score` then
re-embeds what was written, so the ranking is of the real idea and not of the
point it came from.
"""
import json, re, sys, urllib.request
from pathlib import Path
import numpy as np
from model2vec import StaticModel

HERE = Path(__file__).parent
REPO = HERE.parent.parent
FEED = 'https://botchomebrew.wiki/characters.json?fields=card'
TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric']
W = {'ability': 1.0, 'style': 0.45, 'tags': 0.7, 'team': 0.6}
K = 5            # neighbours a gap is measured against
PCA_DIMS = 32    # the search runs here; kNN in 1,000+ dims is all ties
N_SAMPLES = 40000
N_GAPS = 40
rng = np.random.default_rng(7)
model = StaticModel.from_pretrained('minishlab/potion-base-32M')


def unit(m):
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    return m / np.where(n == 0, 1, n)


def split_tags(t):
    if isinstance(t, list):
        return [x.strip() for x in t if x and x.strip()]
    return [x.strip() for x in (t or '').split(',') if x.strip()]


def load_corpus():
    cache = HERE / '.characters.json'
    if not cache.exists():
        req = urllib.request.Request(FEED, headers={'User-Agent': 'botc-novelty'})
        cache.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    rows = []
    for c in json.loads(cache.read_text()):
        if (c.get('ability') or '').strip() and c.get('team') in TEAMS:
            rows.append({'name': c['name'], 'team': c['team'], 'ability': c['ability'].strip(),
                         'style': ' '.join(filter(None, [c.get('quote'), c.get('lede')])),
                         'tags': split_tags(c.get('tags')), 'creator': c.get('creator') or '',
                         'url': 'https://botchomebrew.wiki/' + (c.get('page') or 'c/' + c.get('slug', ''))})
    for c in json.loads((REPO / 'assets/roles.json').read_text()):
        if c.get('team') in TEAMS and c.get('ability'):
            rows.append({'name': c['name'], 'team': c['team'], 'ability': c['ability'],
                         'style': c.get('flavor') or '', 'tags': [], 'creator': 'Official',
                         'url': 'https://wiki.bloodontheclocktower.com/' + c['name'].replace(' ', '_')})
    return rows


class Space:
    """The weighted vector space, fitted on the corpus so new ideas land in it."""

    def __init__(self, rows):
        self.vocab = sorted({t for r in rows for t in r['tags']})
        ab = unit(model.encode([r['ability'] for r in rows]))
        st = unit(model.encode([r['style'] or ' ' for r in rows]))
        has_st = np.array([bool(r['style']) for r in rows])
        tg = self._tags(rows)
        has_tg = np.array([bool(r['tags']) for r in rows])
        # Missing style or tags is unknown, not "none": fill with the corpus
        # mean, which sits in the middle and pulls nobody toward anything.
        self.st_mean, self.tg_mean = st[has_st].mean(0), tg[has_tg].mean(0)
        st[~has_st], tg[~has_tg] = self.st_mean, self.tg_mean
        self.X = self._join(ab, st, tg, self._team(rows))
        self.mu = self.X.mean(0)
        _, _, vt = np.linalg.svd(self.X - self.mu, full_matrices=False)
        self.P = vt[:PCA_DIMS]
        self.Z = self.project(self.X)
        self.sizes = [ab.shape[1], st.shape[1], len(self.vocab), len(TEAMS)]

    def _tags(self, rows):
        m = np.zeros((len(rows), len(self.vocab)))
        ix = {t: i for i, t in enumerate(self.vocab)}
        for i, r in enumerate(rows):
            for t in r['tags']:
                if t in ix:
                    m[i, ix[t]] = 1
        return unit(m)

    def _team(self, rows):
        m = np.zeros((len(rows), len(TEAMS)))
        for i, r in enumerate(rows):
            m[i, TEAMS.index(r['team'])] = 1
        return m

    def _join(self, ab, st, tg, tm):
        return np.hstack([ab * W['ability'], st * W['style'], tg * W['tags'], tm * W['team']])

    def embed(self, rows):
        ab = unit(model.encode([r['ability'] for r in rows]))
        st = unit(model.encode([r['style'] or ' ' for r in rows]))
        st[[not r['style'] for r in rows]] = self.st_mean
        tg = self._tags(rows)
        tg[[not any(t in self.vocab for t in r['tags']) for r in rows]] = self.tg_mean
        return self._join(ab, st, tg, self._team(rows))

    def project(self, X):
        return (X - self.mu) @ self.P.T

    def blocks(self, x):
        out, at = [], 0
        for n in self.sizes:
            out.append(x[at:at + n]); at += n
        return out


def knn(Z, Q, k):
    """Euclidean k nearest rows of Z for each row of Q: (distances, indices)."""
    d2 = (Q * Q).sum(1)[:, None] + (Z * Z).sum(1)[None, :] - 2 * Q @ Z.T
    idx = np.argsort(d2, axis=1)[:, :k]
    return np.sqrt(np.maximum(np.take_along_axis(d2, idx, 1), 0)), idx


def self_nn(Z, k):
    """Each corpus row's distance to its k nearest OTHER rows."""
    d, i = knn(Z, Z, k + 1)
    return d[:, 1:], i[:, 1:]


def clauses(rows):
    seen, out = set(), []
    for r in rows:
        for c in re.split(r'(?<=[.;:])\s+|\s*\[|\]', r['ability']):
            c = c.strip(' .;:')
            if len(c) > 12 and c.lower() not in seen:
                seen.add(c.lower()); out.append(c)
    return out


def gaps():
    rows = load_corpus()
    sp = Space(rows)
    Z = sp.Z
    base, _ = self_nn(Z, K)
    base = base.mean(1)
    print(f'{len(rows)} characters; typical spacing (median {K}-NN distance) {np.median(base):.3f}')

    # Sample between two characters of the same team: the midpoint keeps the
    # team clean and stays inside the cloud, so a far-from-everything point is
    # a gap nobody filled rather than empty space nobody could fill.
    by_team = {t: np.array([i for i, r in enumerate(rows) if r['team'] == t]) for t in TEAMS}
    teams = rng.choice(TEAMS, N_SAMPLES, p=[len(by_team[t]) / len(rows) for t in TEAMS])
    a = np.array([rng.choice(by_team[t]) for t in teams])
    b = np.array([rng.choice(by_team[t]) for t in teams])
    keep = a != b
    a, b = a[keep], b[keep]
    t = rng.uniform(0.3, 0.7, (len(a), 1))
    Q = Z[a] * (1 - t) + Z[b] * t + rng.normal(0, 0.12, (len(a), Z.shape[1])) * Z.std(0)
    d, _ = knn(Z, Q, K)
    score = d.mean(1)

    picked = []
    min_sep = np.median(base) * 1.2  # ponytail: greedy suppression, fine at 40 picks
    for i in np.argsort(-score):
        if all(np.linalg.norm(Q[i] - Q[j]) > min_sep for j in picked) \
                and not any({a[i], b[i]} & {a[j], b[j]} for j in picked):
            picked.append(i)
        if len(picked) == N_GAPS:
            break

    cl = clauses(rows)
    cl_v = unit(model.encode(cl))
    quotes = [r['style'] for r in rows if r['style']]
    q_v = unit(model.encode(quotes))
    out = []
    for n, i in enumerate(picked, 1):
        x = Q[i] @ sp.P + sp.mu                       # back out of PCA
        ab, st, tg, tm = sp.blocks(x)
        dd, nn = knn(Z, Q[i:i + 1], 6)
        out.append({
            'gap': n,
            'gapScore': round(float(score[i] / np.median(base)), 2),
            'team': TEAMS[int(np.argmax(tm))],
            'tags': [sp.vocab[j] for j in np.argsort(-tg)[:5] if tg[j] > 0.04],
            'abilityHints': [cl[j] for j in np.argsort(-(cl_v @ unit(ab)))[:8]],
            'styleHints': [quotes[j][:220] for j in np.argsort(-(q_v @ unit(st)))[:3]],
            'between': [{k: rows[j][k] for k in ('name', 'team', 'ability')} for j in (a[i], b[i])],
            'avoid': [{**{k: rows[j][k] for k in ('name', 'ability')}, 'dist': round(float(e), 3)}
                      for e, j in zip(dd[0], nn[0])],
        })
    (HERE / 'candidates.json').write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f'wrote {len(out)} gaps -> candidates.json')


def score(path):
    rows = load_corpus()
    sp = Space(rows)
    ideas = json.loads(Path(path).read_text())
    for r in ideas:
        r['tags'] = split_tags(r.get('tags'))
        r['style'] = r.get('quote') or ''
    Zi = sp.project(sp.embed(ideas))
    base, _ = self_nn(sp.Z, K)
    base = base.mean(1)
    d, nn = knn(sp.Z, Zi, K)
    nov = d.mean(1)
    for r, s, dd, ii in zip(ideas, nov, d, nn):
        r['novelty'] = round(float(s / np.median(base)), 2)
        r['percentile'] = round(float((base < s).mean() * 100), 1)
        r['closest'] = [{'name': rows[j]['name'], 'creator': rows[j]['creator'], 'url': rows[j]['url'],
                         'dist': round(float(e / np.median(base)), 2)} for e, j in zip(dd[:3], ii[:3])]
    ideas.sort(key=lambda r: -r['novelty'])
    Path(path).with_name('ideas-ranked.json').write_text(json.dumps(ideas, indent=1, ensure_ascii=False))

    md = ['# Character ideas, ranked by how unlike the wiki they are', '',
          f'Measured against {len(rows)} characters (every published page on botchomebrew.wiki '
          'plus the official roster). **Novelty** is the idea\'s average distance to its '
          f'{K} nearest characters, in units of the typical spacing between existing characters '
          '(1.0 = an ordinary character; higher = further from anything that exists). '
          '**Beats** is the share of existing characters that sit closer to their own '
          'neighbours than this idea does.', '',
          'Generated by `migration/character-ideas/novelty.py`; see its header for the method.', '']
    for n, r in enumerate(ideas, 1):
        md += [f'## {n}. {r["name"]} ({r["team"].title()})', '',
               f'**Novelty {r["novelty"]}** - beats {r["percentile"]}% of existing characters', '',
               f'> {r["ability"]}', '']
        if r.get('quote'):
            md += [f'*"{r["quote"]}"*', '']
        md += [f'**Tags:** {", ".join(r["tags"])}', '']
        if r.get('pitch'):
            md += [r['pitch'], '']
        md += ['Nearest existing: ' + '; '.join(
            f'[{c["name"]}]({c["url"]}) by {c["creator"] or "unknown"} ({c["dist"]})' for c in r['closest']), '']
    Path(path).with_name('IDEAS.md').write_text('\n'.join(md))
    print(f'ranked {len(ideas)} ideas -> IDEAS.md')
    for r in ideas:
        print(f'{r["novelty"]:5.2f} {r["percentile"]:5.1f}%  {r["name"]} ({r["team"]})')


if __name__ == '__main__':
    {'gaps': gaps, 'score': lambda: score(sys.argv[2])}[sys.argv[1]]()
