# Cru group dinner pre-order

Guests open one link, enter their name, pick their dishes and save. No account needed. Guests only see their own order. You get a live tally in the organiser view and a Google Sheet with every order.

| File | What it is |
|---|---|
| `index.html` | The whole page (HTML, CSS, JS). Host it on GitHub Pages or Netlify. |
| `cru-logo.png` | Cru's logo, cut out of the printed menu. Upload it next to `index.html`. |
| `Code.gs` | The Google Apps Script backend that reads and writes the Sheet. |
| `dev/mock-server.mjs` | Optional: a local copy of the backend for testing (needs Node 18+). |
| `dev/api-test.mjs` | Optional: server-side checks to run against the mock. |

## How it works

```
phone ──POST (text/plain JSON)──▶ Apps Script web app (doPost) ──▶ Google Sheet
      ◀────────── JSON ──────────
```

- The page sends every request as a `POST` to the web app's `/exec` URL. The body is JSON, for example `{"action":"save","id":"…","order":{…}}`.
- The script checks the order, writes it to the **Orders** tab (one row per guest) and replies with the guest's saved order. Only requests carrying the admin key get everyone's orders back.
- Every 20 seconds the page checks whether orders have closed. In the organiser view it also refreshes the tally then, and straight after each change. It pauses while the tab is in the background.

### The CORS workaround

Apps Script web apps can't answer a CORS *preflight* (`OPTIONS`) request: there is no `doOptions`. So the page sends only "simple" requests, which browsers don't preflight:

1. **`Content-Type: text/plain;charset=utf-8`**, not `application/json`. The body is still JSON. The script reads it with `JSON.parse(e.postData.contents)`.
2. **No custom headers** (no `Authorization`, no `X-…`) and no `credentials: "include"`. Any of these would trigger a preflight.
3. **Follow the redirect.** Google answers `/exec` with a `302` redirect to `script.googleusercontent.com`, and that URL serves the JSON with `Access-Control-Allow-Origin: *`. `fetch` follows it by default.
4. **Errors come back as JSON with HTTP 200**, for example `{"ok":false,"error":"closed","message":"Orders are closed."}`. You can't set status codes from Apps Script, so the page checks `ok` instead.

Secrets stay out of URLs. `doGet` only returns whether orders are open, with no orders in it. Order IDs and the admin key travel in the POST body, and in the page they live after the `#`, which browsers never send to any server.

## Setup

### 1. Create the Sheet

1. Go to <https://sheets.new> and name the spreadsheet, for example "Cru dinner orders".
2. **File → Settings → Time zone:** pick *(GMT+07:00) Bangkok*, so the Updated and Created times show in local time.

### 2. Add the script

1. In the Sheet: **Extensions → Apps Script**.
2. Delete the sample code in `Code.gs`, paste in the full contents of this repo's `Code.gs`, and press **Save** (💾).
3. In the function menu at the top, choose **`setup`** and press **Run**.
4. Google asks for permission. Choose your account, then **Advanced → Go to (project name) (unsafe)**, then **Allow**. The warning appears because the script is yours and Google hasn't reviewed it. It only touches this spreadsheet.
5. Open the **Execution log**. It shows a line like:
   `Your admin link is your page URL followed by:  #admin-3f9c1a…`
   Copy that `#admin-…` part and keep it private.

The Sheet now has two tabs, **Orders** and **Dish totals**.

### 3. Deploy the web app

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear ⚙ next to "Select type" and choose **Web app**.
3. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone* (not "Anyone with Google account"; guests must not need to sign in)
4. Press **Deploy** and copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.
5. Optional check: open that URL in a browser tab. You should see `{"ok":true,"orders":[],…}`.

### 4. Connect the page

Open `index.html` in a text editor. Near the top of the `<script>` block, paste your URL:

```js
const API_URL = "https://script.google.com/macros/s/AKfy…/exec";
```

### 5. Host the page

**GitHub Pages**

1. Create a new **public** repository on GitHub, for example `cru-dinner`. On a free account, Pages only works for public repos. That's fine: the page holds no secrets, and the admin key isn't in it.
2. **Add file → Upload files**, upload `index.html` and commit.
3. **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, Branch to **main** and folder **/ (root)**, then **Save**.
4. After a minute or so the page is live at `https://<your-username>.github.io/cru-dinner/`.

**Netlify (alternative)**

1. Sign in at <https://app.netlify.com> (free). Without an account, Netlify Drop sites are deleted after a short while.
2. Open <https://app.netlify.com/drop> and drag in a folder containing `index.html`.
3. Netlify gives you a URL like `https://random-name.netlify.app`. You can rename it under **Site configuration → Change site name**.

### 6. Share it

- **Guests:** post the page URL in the group chat.
- **You:** open the page URL followed by your admin suffix, for example
  `https://<you>.github.io/cru-dinner/#admin-3f9c1a…`. Bookmark it, and never post it.

## Using it

**Guests** fill in their name, add any mix of mains, sharing plates and sides (all optional, up to 9 of each), and press **Save order**. The page stores a random order ID on their phone, so when they come back it opens their order ready to change. After saving, they see a private **edit link** (`…#order-ID`) they can copy to edit from another device. **Remove** asks for a second tap to confirm.

**Organiser view** (`#admin-KEY`) shows the live tally below the form (orders in, mains, food total, counts per dish with egg yolks, and a by-person table with dietary notes). Guests don't see it. It also adds a panel above the form:

- **Order deadline:** switch it on and pick a date and time. Once that time passes, guests can't save or remove orders; the page tells them to ask you. You can still edit your own order. Switch it off to reopen.
- **Close orders now:** sets the deadline to the current time (tap twice).
- **Copy kitchen summary:** copies a plain-text list of dish counts (including egg yolks), dietary notes and each guest's full order (mains, sharing plates and sides), ready to send to Cru. **Preview kitchen summary** shows the same text, in case your phone blocks clipboard access.
- **Remove** buttons on each row of the by-person table, for duplicates or no-shows.

**The Sheet**

- **Orders** has one row per guest: name, a column per dish (mains included), egg yolks, dietary notes, total, timestamps and order ID. A hidden **Data** column holds the exact saved order, and the script treats it as the source of truth. Read the other columns freely, but make changes through the page: hand edits are overwritten the next time that guest saves.
- **Dish totals** has a count and subtotal per dish, all `SUM` formulas over the Orders tab, plus orders in, food total, and a check against the per-guest totals.

## Admin key and deadline settings

Both are stored as **Script properties**. Find them in the Apps Script editor under **Project Settings (⚙) → Script properties**.

| Property | Meaning |
|---|---|
| `ADMIN_KEY` | The secret after `#admin-`. Edit it here to choose your own (8+ characters, letters and digits). |
| `DEADLINE` | When orders close, as an ISO date such as `2026-11-07T18:00:00+07:00`. Delete the property for no deadline. The admin view's toggle sets this for you. |

Functions you can run from the editor (choose one in the function menu, then press **Run**):

| Function | What it does |
|---|---|
| `showSettings` | Prints the admin link suffix and the deadline. |
| `newAdminKey` | Creates a new admin key. Old admin links stop working. |
| `clearDeadline` | Removes the deadline so guests can save again. |
| `resetOrders` | **Deletes every order.** Keeps the tabs, admin key and deadline. |
| `setup` | Rebuilds both tabs from the saved data. Safe to re-run; no orders are lost. |

Script properties take effect immediately. **Changes to the code don't**: after editing `Code.gs`, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.

## Resetting all orders

1. Apps Script editor → choose **`resetOrders`** → **Run**.
2. Optionally run `clearDeadline` too, if you're reusing the page for another dinner.

Guests who ordered before the reset still have their old order ID on their phone. The page simply shows them an empty form, and saving creates a new order.

## Changing the menu

The menu lives in two places, kept deliberately simple:

1. **`index.html`:** the `MENU` array at the top of the script. This is what guests see: names, Thai names, sizes, prices, short descriptions (`desc`), chilli icons for spicy dishes (`hot`), and the egg yolk price on the larb.
2. **`Code.gs`:** the `MENU` array at the top. This is what the server accepts, and what the Sheet columns and totals use.

Use the same `id` and price in both files. Then:

1. Run `setup` once, so the Sheet columns and Dish totals match the new menu. Existing orders are kept.
2. Deploy a new version (see above).
3. Upload the new `index.html`.

If the two lists disagree, the organiser view shows a warning naming the mismatched IDs. If a guest picks a dish the server doesn't know, the server rejects the save with "Unknown dish".

## What the server checks

The page validates as guests go, and the server checks everything again before writing:

- Only known dish IDs. Only the name is required; every dish is optional.
- Quantities are whole numbers from 0 to 9. Egg yolks (0–9, ฿20 each) need at least one larb in the order, but can outnumber the larb portions.
- Name: 1–60 characters. Notes: up to 400. Control characters are stripped and whitespace is tidied.
- Order IDs must be 16–64 letters and digits, and the page generates 24 random ones. Guests never receive other guests' orders or order IDs, so nobody can see or edit someone else's order.
- Text starting with `=`, `+`, `-` or `@` is stored as plain text, so a guest can't put a formula into your Sheet.
- Requests over 10 KB are refused, and the list is capped at 150 orders.
- Writes take a script lock, so two guests saving at the same moment can't overwrite each other.

**Privacy:** guests see only their own order. The server sends other guests' names, dishes and dietary notes only to the organiser view, so they aren't hidden in the page data either. The edit link works like a password for one order, so guests shouldn't share it.

## Testing locally

The mock server runs the real `Code.gs` against an in-memory fake Sheet. It copies Google's redirect and CORS behaviour, and it refuses preflight requests the way Apps Script does.

```bash
node dev/mock-server.mjs
```

Then open:

- Guest view: <http://localhost:8080/?api=http://localhost:8787/exec>
- Organiser view: <http://localhost:8080/?api=http://localhost:8787/exec#admin-localadminkey1>
- The fake Sheet, with Dish totals formulas evaluated: <http://localhost:8787/__sheet>

To simulate a second phone, open the same URL with `127.0.0.1` in place of `localhost`. It's a different origin, so it has its own storage.

With the mock running, the server-side checks run from a second terminal:

```bash
node dev/api-test.mjs
```

The `?api=` override only works when the page itself is served from `localhost`, so nobody can point your hosted page at another server.

## Troubleshooting

- **"Couldn't reach the order sheet"**
  - Check the URL ends in `/exec` (not `/dev`).
  - Check that access is set to *Anyone*.
  - Open the URL directly: you should see JSON.
- **The page behaves as before after you changed `Code.gs`:** deploy a new version (Manage deployments → Edit → New version).
- **"This admin link isn't valid":** run `showSettings` and compare the key.
- **Orders tab looks wrong after hand edits:** run `setup` to redraw it from the saved data.
- **Quotas:** a free Google account comfortably handles 30 guests refreshing every 20 seconds. Polling stops while a guest's tab is in the background.
