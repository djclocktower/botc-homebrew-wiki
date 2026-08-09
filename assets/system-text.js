/* System text the WORKER renders into pages.

   Why this file exists
   --------------------
   /text-editor (the admin text editor) builds its catalogue by fetching the
   site's own files in the browser and pulling the human-readable strings out
   of them. It can read every .html page and every assets/*.js file, because
   those are served as static assets — but it can NEVER read worker/worker.js,
   which is excluded from the asset upload on purpose (.assetsignore).

   So any prose the Worker prints into a page lives here instead, in a file
   that IS served. worker.js imports this module and uses these constants; the
   text editor fetches the same file and lists them like any other string.

   If you add new prose to a server-rendered page in worker.js, put the words
   here and reference them — otherwise the text editor cannot see them and the
   owner cannot edit them.

   Scope note: only text that ends up inside a page belongs here. API error
   messages (returned as JSON and usually shown in an alert) are not covered
   by the editor, because overrides are applied to the page's DOM in the
   browser — there is no DOM to patch for an alert().

   {placeholder} marks a slot the site fills in at render time. The editor
   knows about them: an override must keep the placeholder or the filled-in
   value is lost. */
(function () {
  'use strict';

  var SYSTEM_TEXT = {
    /* The "this page is Partial" banner above the topbar on a /c/ page.
       Only ever shown to the page's owner and to admins, which is what the
       parenthesis in partialBody is telling the one person who sees it. */
    partialLabel: 'PARTIAL',
    partialBody: '— (Only you can see this warning.)',
    partialFix: 'Add {missing} to finish.',
    partialEdit: 'Edit this page →',
    partialDismiss: 'Dismiss this warning',

    /* The draft bar at the very top of an unpublished page. */
    draftPage: 'DRAFT — only you can see this page. Publish it from',
    draftArticle: 'DRAFT — only you can see this article. Publish it from',
    draftEditorLink: 'the editor'
  };

  if (typeof window !== 'undefined') window.SystemText = SYSTEM_TEXT;
  if (typeof module !== 'undefined' && module.exports) module.exports = SYSTEM_TEXT;
})();
