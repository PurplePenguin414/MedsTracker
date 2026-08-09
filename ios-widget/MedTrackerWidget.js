// Med Refill Tracker — iOS Home Screen Widget
// Requires the free "Scriptable" app from the App Store.
//
// SETUP:
// 1. Open Scriptable, tap + to create a new script, paste this whole file in.
// 2. Replace WIDGET_URL and WIDGET_KEY below with your real values.
// 3. Tap the wrench icon (bottom right) > run once to test.
// 4. Long-press your iPhone home screen > tap + (top left) > search "Scriptable"
//    > choose the medium or small widget size > add it.
// 5. Long-press the new widget > Edit Widget > set "Script" to this script's name.
//
// The widget refreshes periodically on iOS's own schedule (usually every
// 15-60 min); tap the widget to jump straight into the app.

const WIDGET_URL = "https://meds.megangibbs.net/api/widget/summary";
const WIDGET_KEY = "PASTE_YOUR_WIDGET_API_KEY_HERE";

async function getData() {
  const req = new Request(`${WIDGET_URL}?key=${WIDGET_KEY}`);
  req.timeoutInterval = 10;
  try {
    return await req.loadJSON();
  } catch (e) {
    return { error: true };
  }
}

function colorFor(status) {
  if (status === "overdue") return new Color("#b8483c");
  if (status === "due_soon") return new Color("#b8862c");
  if (status === "as_needed_no_refills") return new Color("#b8862c");
  return new Color("#3f8f5f");
}

function daysLabelFor(med) {
  if (med.days_until_call === null || med.days_until_call === undefined) {
    return med.status === "as_needed_no_refills" ? "no refills" : "";
  }
  const d = med.days_until_call;
  if (d < 0) return `${Math.abs(d)}d overdue`;
  if (d === 0) return "today";
  return `in ${d}d`;
}

async function createWidget(data) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#f7f5f0");
  w.url = data.app_url || WIDGET_URL.replace("/api/widget/summary", "");
  w.setPadding(14, 14, 14, 14);

  if (data.error) {
    const t = w.addText("Couldn't load Med Tracker");
    t.font = Font.mediumSystemFont(13);
    t.textColor = new Color("#b8483c");
    return w;
  }

  const title = w.addText("💊 Med Tracker");
  title.font = Font.boldSystemFont(15);
  title.textColor = new Color("#2b2822");
  w.addSpacer(6);

  const totalFlags = data.counts.overdue + data.counts.due_soon + data.counts.as_needed_no_refills;

  if (totalFlags === 0) {
    const ok = w.addText("✅ All on track");
    ok.font = Font.systemFont(13);
    ok.textColor = new Color("#3f8f5f");
  } else {
    const summary = w.addText(
      `${data.counts.overdue} overdue · ${data.counts.due_soon} due soon`
    );
    summary.font = Font.systemFont(11);
    summary.textColor = new Color("#8a8478");
    w.addSpacer(8);

    const shown = data.needs_attention.slice(0, 4);
    for (const med of shown) {
      const row = w.addStack();
      row.layoutHorizontally();
      row.centerAlignContent();

      const dot = row.addText("●");
      dot.font = Font.systemFont(10);
      dot.textColor = colorFor(med.status);
      row.addSpacer(5);

      const name = row.addText(med.name);
      name.font = Font.mediumSystemFont(12);
      name.textColor = new Color("#ffffff");
      name.lineLimit = 1;

      row.addSpacer();

      const days = row.addText(daysLabelFor(med));
      days.font = Font.systemFont(10);
      days.textColor = colorFor(med.status);
      days.rightAlignText();

      w.addSpacer(3);
    }

    if (data.needs_attention.length > shown.length) {
      w.addSpacer(2);
      const more = w.addText(`+${data.needs_attention.length - shown.length} more`);
      more.font = Font.systemFont(10);
      more.textColor = new Color("#8a8478");
    }
  }

  return w;
}

const data = await getData();
const widget = await createWidget(data);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
