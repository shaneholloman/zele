// Tests for htmlToMarkdown email rendering.
// Uses inline snapshots to capture how real-world email HTML is converted.

import { expect, test } from 'vitest'
import { htmlToMarkdown, renderEmailBody } from './output.js'

// ---------------------------------------------------------------------------
// Simple HTML
// ---------------------------------------------------------------------------

test('simple inline tags', () => {
  expect(htmlToMarkdown('<p>Hello <b>bold</b> and <em>italic</em> world</p>')).toMatchInlineSnapshot(`"Hello **bold** and *italic* world"`)
})

test('headings and paragraphs', () => {
  expect(htmlToMarkdown('<h1>Title</h1><p>Paragraph one.</p><h2>Subtitle</h2><p>Paragraph two.</p>')).toMatchInlineSnapshot(`
    "# Title

    Paragraph one.

    ## Subtitle

    Paragraph two."
  `)
})

test('links', () => {
  expect(htmlToMarkdown('<p>Visit <a href="https://example.com">our site</a> today.</p>')).toMatchInlineSnapshot(`"Visit [our site](https://example.com) today."`)
})

test('unordered list', () => {
  expect(htmlToMarkdown('<ul><li>One</li><li>Two</li><li>Three</li></ul>')).toMatchInlineSnapshot(`
    "* One
    * Two
    * Three"
  `)
})

test('ordered list', () => {
  expect(htmlToMarkdown('<ol><li>First</li><li>Second</li><li>Third</li></ol>')).toMatchInlineSnapshot(`
    "1. First
    2. Second
    3. Third"
  `)
})

// ---------------------------------------------------------------------------
// Email-specific: tracking pixels
// ---------------------------------------------------------------------------

test('strips 1x1 tracking pixels', () => {
  expect(htmlToMarkdown('<p>Hello</p><img src="https://track.example.com/pixel.gif" width="1" height="1"><p>World</p>')).toMatchInlineSnapshot(`
    "Hello

    World"
  `)
})

test('strips beacon/tracker images by URL', () => {
  expect(htmlToMarkdown('<p>Content</p><img src="https://analytics.example.com/beacon?id=123">')).toMatchInlineSnapshot(`"Content"`)
})

// ---------------------------------------------------------------------------
// Email-specific: image alt text
// ---------------------------------------------------------------------------

test('replaces images with alt text placeholder', () => {
  expect(htmlToMarkdown('<img src="https://example.com/logo.png" alt="Company Logo">')).toMatchInlineSnapshot(`"[image: Company Logo]"`)
})

test('strips images without alt text', () => {
  expect(htmlToMarkdown('<p>Before</p><img src="https://example.com/spacer.png"><p>After</p>')).toMatchInlineSnapshot(`
    "Before

    After"
  `)
})

// ---------------------------------------------------------------------------
// Email-specific: layout tables
// ---------------------------------------------------------------------------

test('unwraps layout table with width attribute', () => {
  expect(htmlToMarkdown(`
    <table width="600" cellpadding="0" cellspacing="0">
      <tr><td>
        <h1>Welcome</h1>
        <p>This is inside a layout table.</p>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "# Welcome

    This is inside a layout table."
  `)
})

test('unwraps nested layout tables', () => {
  expect(htmlToMarkdown(`
    <table width="600" align="center">
      <tr><td>
        <table width="100%">
          <tr><td>Column 1</td></tr>
        </table>
        <table width="100%">
          <tr><td>Column 2</td></tr>
        </table>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "Column 1

    Column 2"
  `)
})

test('unwraps table with role=presentation', () => {
  expect(htmlToMarkdown(`
    <table role="presentation">
      <tr><td><p>Presented content</p></td></tr>
    </table>
  `)).toMatchInlineSnapshot(`"Presented content"`)
})

// ---------------------------------------------------------------------------
// Email-specific: hidden elements
// ---------------------------------------------------------------------------

test('strips display:none elements', () => {
  expect(htmlToMarkdown('<div style="display:none">Hidden</div><p>Visible</p>')).toMatchInlineSnapshot(`"Visible"`)
})

test('strips mso-hide:all elements', () => {
  expect(htmlToMarkdown('<span style="mso-hide:all">MSO only</span><p>Regular</p>')).toMatchInlineSnapshot(`"Regular"`)
})

test('strips preheader spans', () => {
  expect(htmlToMarkdown('<span class="preheader">Preview text here</span><p>Email body</p>')).toMatchInlineSnapshot(`"Email body"`)
})

// ---------------------------------------------------------------------------
// Email-specific: quoted replies
// ---------------------------------------------------------------------------

test('strips Gmail quoted reply blocks', () => {
  expect(htmlToMarkdown(`
    <p>This is my reply.</p>
    <div class="gmail_quote">
      <p>On Mon, Jan 1 2026, someone wrote:</p>
      <blockquote><p>Original message here</p></blockquote>
    </div>
  `)).toMatchInlineSnapshot(`"This is my reply."`)
})

test('strips Gmail extra blocks', () => {
  expect(htmlToMarkdown(`
    <p>Reply text.</p>
    <div class="gmail_extra">
      <div class="gmail_quote">
        <p>Quoted content</p>
      </div>
    </div>
  `)).toMatchInlineSnapshot(`"Reply text."`)
})

test('strips Outlook blockquote type=cite', () => {
  expect(htmlToMarkdown(`
    <p>My response.</p>
    <blockquote type="cite">
      <p>Original text being quoted</p>
    </blockquote>
  `)).toMatchInlineSnapshot(`"My response."`)
})

// ---------------------------------------------------------------------------
// Email-specific: Outlook conditional comments
// ---------------------------------------------------------------------------

test('strips Outlook conditional comments', () => {
  expect(htmlToMarkdown(`
    <p>Normal content</p>
    <![if mso]><table><tr><td>MSO only</td></tr></table><![endif]>
    <p>More content</p>
  `)).toMatchInlineSnapshot(`
    "Normal content

    More content"
  `)
})

// ---------------------------------------------------------------------------
// Email-specific: style/script/head tags
// ---------------------------------------------------------------------------

test('strips style tags', () => {
  expect(htmlToMarkdown('<style>.foo { color: red; }</style><p>Content</p>')).toMatchInlineSnapshot(`"Content"`)
})

test('strips script tags', () => {
  expect(htmlToMarkdown('<script>alert("xss")</script><p>Safe content</p>')).toMatchInlineSnapshot(`"Safe content"`)
})

// ---------------------------------------------------------------------------
// Real-world: Google security alert (simplified)
// ---------------------------------------------------------------------------

test('Google security alert email', () => {
  expect(htmlToMarkdown(`
    <table width="100%" style="min-width:348px" border="0" cellspacing="0" cellpadding="0">
      <tr><td>
        <table align="center" border="0" cellspacing="0" cellpadding="0" width="600">
          <tr><td>
            <img src="https://accounts.google.com/logo.png" alt="Google" width="75" height="24">
          </td></tr>
          <tr><td>
            <h2>You allowed Thunderbird access to your Google Account</h2>
            <p>user@gmail.com</p>
            <p>If you didn't allow Thunderbird, someone else may be trying to access your account.</p>
            <p><a href="https://myaccount.google.com/alert">Check activity</a></p>
          </td></tr>
          <tr><td>
            <p style="font-size:11px;color:#777">
              © 2026 Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "[image: Google]

    ## You allowed Thunderbird access to your Google Account

    user@gmail.com

    If you didn't allow Thunderbird, someone else may be trying to access your account.

    [Check activity](https://myaccount.google.com/alert)

    © 2026 Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland"
  `)
})

// ---------------------------------------------------------------------------
// Real-world: Stripe receipt (simplified)
// ---------------------------------------------------------------------------

test('Stripe receipt email', () => {
  expect(htmlToMarkdown(`
    <table width="600" align="center" cellpadding="0" cellspacing="0" border="0">
      <tr><td>
        <table width="100%" border="0" cellpadding="0">
          <tr><td><h2>Receipt from X</h2></td></tr>
          <tr><td><p><strong>$16.00</strong></p></td></tr>
          <tr><td><p>Paid February 9, 2026</p></td></tr>
        </table>
        <table width="100%" border="0" cellpadding="0">
          <tr><td>Receipt number</td><td>2383-9009-8737</td></tr>
          <tr><td>Payment method</td><td>Mastercard - 8441</td></tr>
        </table>
        <table width="100%" border="0" cellpadding="0">
          <tr><td>X Premium Plus</td><td>$40.00</td></tr>
          <tr><td>Discount (60% off)</td><td>-$24.00</td></tr>
          <tr><td><strong>Total</strong></td><td><strong>$16.00</strong></td></tr>
        </table>
        <p>Questions? <a href="https://help.x.com">Visit support</a></p>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "## Receipt from X

    **$16.00**

    Paid February 9, 2026

    Receipt number

    2383-9009-8737

    Payment method

    Mastercard - 8441

    X Premium Plus

    $40.00

    Discount (60% off)

    -$24.00

    **Total**

    **$16.00**

    Questions? [Visit support](https://help.x.com)"
  `)
})

// ---------------------------------------------------------------------------
// Real-world: newsletter with CTA buttons
// ---------------------------------------------------------------------------

test('newsletter with headings and CTAs', () => {
  expect(htmlToMarkdown(`
    <table width="600" align="center" cellpadding="0" cellspacing="0">
      <tr><td>
        <p>Hi there,</p>
        <p>We've launched a new <strong>AI Assistant</strong>.</p>
        <table width="100%" cellpadding="0"><tr><td>
          <a href="https://app.example.com/try" style="background:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px">Try it now</a>
        </td></tr></table>
        <h3>Getting started</h3>
        <p>Click the button above to begin.</p>
        <ul>
          <li>Search by meaning</li>
          <li>Summarize articles</li>
          <li>Organize bookmarks</li>
        </ul>
        <p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "Hi there,

    We've launched a new **AI Assistant**.

    [Try it now](https://app.example.com/try)

    ### Getting started

    Click the button above to begin.

    * Search by meaning
    * Summarize articles
    * Organize bookmarks

    [Unsubscribe](https://example.com/unsubscribe)"
  `)
})

// ---------------------------------------------------------------------------
// Combined: hidden + tracking + layout in one email
// ---------------------------------------------------------------------------

test('combined email noise removal', () => {
  expect(htmlToMarkdown(`
    <span class="preheader" style="display:none">Preview: Check out our deals!</span>
    <img src="https://track.example.com/open?id=abc" width="1" height="1">
    <table width="600" align="center" cellpadding="0" cellspacing="0">
      <tr><td>
        <div style="display:none">Hidden duplicate content</div>
        <h1>Big Sale!</h1>
        <p>Everything is <b>50% off</b> today.</p>
        <p><a href="https://shop.example.com">Shop now</a></p>
      </td></tr>
    </table>
    <img src="https://pixel.example.com/beacon" width="0" height="0">
  `)).toMatchInlineSnapshot(`
    "# Big Sale!

    Everything is **50% off** today.

    [Shop now](https://shop.example.com)"
  `)
})

// ---------------------------------------------------------------------------
// renderEmailBody: plain text pass-through
// ---------------------------------------------------------------------------

test('renderEmailBody passes through plain text', () => {
  expect(renderEmailBody('Hello, this is plain text.\n\nSecond paragraph.', 'text/plain')).toMatchInlineSnapshot(`
    "Hello, this is plain text.

    Second paragraph."
  `)
})

test('renderEmailBody converts HTML', () => {
  expect(renderEmailBody('<p>Hello <b>world</b></p>', 'text/html')).toMatchInlineSnapshot(`"Hello **world**"`)
})
