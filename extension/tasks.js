const count = document.querySelector("#task-count");
const list = document.querySelector("#task-list");
const message = document.querySelector("#message");

function send(payload) {
  return chrome.runtime.sendMessage(payload).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Tasks unavailable");
    return response;
  });
}

async function refresh() {
  const { tasks = [] } = await send({ type: "tasks.list" });
  list.replaceChildren();
  count.textContent = String(tasks.length);
  if (tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "summary";
    empty.textContent = "No browser task has been created yet.";
    list.append(empty);
    return;
  }
  for (const task of tasks) {
    const article = document.createElement("article");
    article.className = "receipt-row";
    const heading = document.createElement("h3");
    heading.textContent = task.label || "Browser task";
    const detail = document.createElement("p");
    detail.textContent = `${task.status} · ${task.pageCount} page ${task.pageCount === 1 ? "binding" : "bindings"} · expires ${task.expiresAt || "when ended"}`;
    article.append(heading, detail);
    if (["active", "paused"].includes(task.status)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary danger";
      button.textContent = "End task";
      button.addEventListener("click", async () => {
        if (!window.confirm(`End ${task.label || "this task"} and revoke its temporary authority?`)) return;
        button.disabled = true;
        try { await send({ type: "task.revoke", taskId: task.taskId }); await refresh(); }
        catch (error) { message.textContent = error.message; button.disabled = false; }
      });
      article.append(button);
    }
    list.append(article);
  }
}

document.querySelector("#rules-button").addEventListener("click", () => send({ type: "page.open_rules" }));
refresh().catch((error) => { count.textContent = "Unavailable"; count.dataset.tone = "danger"; message.textContent = error.message; });
