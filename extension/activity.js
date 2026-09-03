const count = document.querySelector("#activity-count");
const list = document.querySelector("#activity-list");
const message = document.querySelector("#message");

function send(payload) {
  return chrome.runtime.sendMessage(payload).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Activity unavailable");
    return response;
  });
}

function line(label, value) {
  const row = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  row.append(strong, document.createTextNode(value || "Unknown"));
  return row;
}

function render(receipts) {
  list.replaceChildren();
  count.textContent = String(receipts.length);
  if (receipts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "summary";
    empty.textContent = "No protected actions have produced receipts yet.";
    list.append(empty);
    return;
  }
  for (const receipt of receipts) {
    const article = document.createElement("article");
    article.className = "receipt-row";
    const heading = document.createElement("h3");
    heading.textContent = receipt.title || "Protected action";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Open receipt";
    button.addEventListener("click", () => send({ type: "page.open_receipt", receiptId: receipt.receiptId }));
    article.append(
      heading,
      line("Outcome", String(receipt.outcome || "unknown").replaceAll("_", " ")),
      line("Page", receipt.origin),
      line("Time", receipt.terminalAt),
      button,
    );
    list.append(article);
  }
}

send({ type: "activity.list" }).then((response) => render(response.receipts || [])).catch((error) => {
  count.textContent = "Unavailable";
  count.dataset.tone = "danger";
  message.textContent = error.message;
});
