-- The Emotions set, moved from a collection to a script, and its art
-- moved off the author's host into the repo. What was actually run
-- against D1 after the first import; a fresh import runs characters-*.sql
-- and script.sql instead, which already carry this shape.

-- 1. every character points at the committed art, and no longer at
--    user-images.klutzbanana.com. artVersions() builds the page's <img>
--    AND the official-schema JSON's absolute url from the relative path,
--    so an absolute image left beside it would put the author's host back
--    into the export.
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/fear.png','$.artAlt','art/fear-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='fear';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/guilt.png','$.artAlt','art/guilt-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='guilt';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/anxiety.png','$.artAlt','art/anxiety-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='anxiety';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/anger.png','$.artAlt','art/anger-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='anger';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/sadness.png','$.artAlt','art/sadness-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='sadness';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/grief.png','$.artAlt','art/grief-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='grief';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/disappointment.png','$.artAlt','art/disappointment-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='disappointment';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/boredom.png','$.artAlt','art/boredom-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='boredom';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/excitement.png','$.artAlt','art/excitement-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='excitement';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/gratitude.png','$.artAlt','art/gratitude-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='gratitude';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/happiness.png','$.artAlt','art/happiness-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='happiness';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/love.png','$.artAlt','art/love-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='love';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/hope.png','$.artAlt','art/hope-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='hope';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/faith.png','$.artAlt','art/faith-alt.png'),'$.image','$.imageAlt'), updated_at=datetime('now') WHERE slug='faith';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/depression.png','$.artAlt','art/depression-alt.png','$.artAlt2','art/depression-alt2.png'),'$.image','$.imageAlt','$.imageAlt2'), updated_at=datetime('now') WHERE slug='depression';
UPDATE characters SET data=json_remove(json_set(data,'$.art','art/the-spiral.png'),'$.image'), updated_at=datetime('now') WHERE slug='the-spiral';

-- 2. the set is a script, not a collection: a playable roster with a night
--    order, which a /s/ page renders and a collection page deliberately
--    does not. The characters' appearsIn stays 'Emotions' and now resolves
--    through findScriptRowLoose instead, giving the same 'emotions' address
--    segment, so no character URL moves.
DELETE FROM collections WHERE slug='emotions';
INSERT INTO scripts (slug,name,author,owner_id,data,status,created_at,updated_at) VALUES ('emotions','Emotions','Moll',NULL,'{"slug":"emotions","name":"Emotions","author":"Moll","creator":"Moll","version":"3.2","characters":["fear","guilt","anxiety","anger","sadness","grief","disappointment","boredom","excitement","gratitude","happiness","love","hope","faith","depression","the-spiral"],"synopsis":"A script around Minions, this time they are less about causing chaos and misinformation. This time its their task to figure out, are shown actual Love or is it just Hope someone has laid out for them. Figure out if you have someone else like you out there, and if you should turn on your demon, while the demon might be trying to lead you on the wrong path. This script isn''t only built around the evil team lying, the good team is heavily encouraged to lie to avoid these evils & to make out something they really shouldn''t have.\n\nMaybe you have a friend who needs to travel, but its usually terribly unbalanced in teensyvilles, not to worry. You can come into the town as Depression, and lead the town through a ride of emotions.","logo":"scripts/emotions-logo.png","almanac":"https://klutzbanana.com/scripts/e5govpsx4u/Emotions%20by%20Moll","curata":false,"customBoxes":[{"title":"Thanks","content":"Thanks to the people who helped a lot with the playtesting of this; special thanks to Swampert, Lucifer, Wildheart, Syddanus, Jasper, Nicklas, Hobbe, Aki & Audeeophile for many long nights."}]}','published',datetime('now'),datetime('now'));

-- 3. the feeds and the in-isolate caches are keyed on this (Gotcha 13).
INSERT INTO settings (key,value) VALUES ('content_version','1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT);
