const base = process.env.MEMORY_URL;
const key = process.env.DEMO_API_KEY;
if (!base || !key) throw new Error("Set MEMORY_URL and DEMO_API_KEY.");
const response = await fetch(`${base.replace(/\/$/, "")}/demo`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}` },
});
if (!response.ok)
  throw new Error(
    `Demo request failed: ${response.status} ${await response.text()}`,
  );
let pending = "";
const decoder = new TextDecoder();
for await (const chunk of response.body) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    const event = JSON.parse(line);
    console.log(JSON.stringify(event, null, 2));
    if (event.event === "error") process.exitCode = 1;
  }
}
