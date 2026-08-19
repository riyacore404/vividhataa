# VIVIDHATA Registration API

The website remains static. Registration submissions are handled by the small Node/Express service in `backend/server.js`.

## Architecture

`registration.html` sends multipart `POST /api/register` to the API. The API validates the event and fields, checks duplicates by event ID plus email, generates a `VIV-YYYY-XXXXXXXX` ID, appends a row to Google Sheets, and optionally uploads configured files to Google Drive.

Google credentials are server-only. They are never loaded by `events.html`, `events-data.js`, `registration.html`, or `registration-config.js`.

## Install and run locally

```bash
npm install
cp .env.example .env
npm start
```

The static site can be served separately, for example:

```bash
python3 -m http.server 8001
```

Set `FRONTEND_ORIGIN=http://localhost:8001` in `.env`. The frontend defaults to `/api/register`; when the API is on another origin, set the public API URL in `registration-config.js`, for example:

```js
window.VIVIDHATA_REGISTRATION_API_URL = 'https://api.example.com/api/register';
```

That file may contain a public URL only. Never put secrets there.

## Google setup

1. Create or select a Google Cloud project.
2. Enable **Google Sheets API** and **Google Drive API**.
3. Create a service account and generate a private key. Keep the downloaded JSON outside the repository.
4. Create a spreadsheet and copy its ID into `GOOGLE_SHEET_ID`.
5. Share the spreadsheet with `GOOGLE_SERVICE_ACCOUNT_EMAIL` as Editor.
6. Copy the service account email and private key into the server `.env` only. Replace escaped `\\n` values as shown in `.env.example`.
7. Put the worksheet/tab name in `GOOGLE_SHEET_NAME`. The API creates the header row when the sheet is empty.
8. For uploads, create a Drive folder, share it with the service account as Editor, and set its ID in `GOOGLE_DRIVE_FOLDER_ID`.
9. Deploy the API on a Node host with the same environment variables and set `FRONTEND_ORIGIN` to the exact deployed website origin. Multiple comma-separated origins are supported.
10. Point `registration-config.js` at the deployed `/api/register` endpoint.

## File fields

Event data remains the source of truth. Add a file field to an event's `registration.fields` array:

```js
registration: {
  enabled: true,
  fields: [
    {
      id: 'resume',
      label: 'RESUME',
      type: 'file',
      required: false,
      acceptExtensions: ['.pdf'],
      acceptTypes: ['application/pdf'],
      maxSizeMb: 10
    }
  ]
}
```

The backend validates field name, MIME type, extension, and size before uploading. Files are stored under the configured Drive folder as `event-id/registration-id/unique-filename`; the resulting Drive references are stored in the Sheet's `File URLs` column. The form renderer should expose matching file inputs when fields are enabled.

## Sheet columns

The API writes: Timestamp, Registration ID, Event ID, Event Name, Category, Full Name, Email, Contact Number, College / Institution, Course / Branch, Year of Study, Team Name, Team Size, Team Members, Motivation, Additional Information, Registration Status, and File URLs.

## Testing

Use `GET /health` to check the API process. Then submit a valid form from `registration.html?event=hackathon-2026`. Verify the returned ID appears in the success state and a new row appears in the configured sheet. Submit the same event/email again to verify the duplicate response. Test invalid files against the configured size/type rules.
