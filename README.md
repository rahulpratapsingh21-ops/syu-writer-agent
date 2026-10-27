# SYU Writer Agent - SYUW1 (beta 0.0)

Uploads finished articles from Google Docs into the SYU CMS, as the writer account.

- Reads a Google Sheet row: **Title, Task ID, Writer, Doc URL**.
- Finds the task's draft in the CMS (clicks **Start** as the writer if the task is not started yet).
- Converts the Google Doc: doc Title → H1, tables 100% wide with equal columns, interlinks kept (Google redirects removed),
  CTAs added based on the content (linking to the lead form), FAQ as "Q." / "Ans." with a gap between questions.
  Images in the doc (e.g. AI-detector screenshots) are not uploaded.
- Makes a branded hero image (1280×720) and uploads it.
- Date = today, author name = the sheet's Writer column.
- Saves as a draft and (by default) submits for the editor's review. Never publishes.

Blogs only for now; college / exam / course silos are next.

## Run
```
npm install
npm start        # http://localhost:3002
```
Or double-click `START-WRITER-AGENT.bat`.

## Settings (.env)
`CMS_URL`, `CMS_EMAIL` (writer account), `CMS_PASSWORD`, `PORT`, `DASHBOARD_PASSWORD` (optional).
