// Assay site behaviour: live 402 demo, copy-as-markdown. No trackers.
(function(){
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Copy as markdown
  document.querySelectorAll("[data-copy-md]").forEach((b) => b.addEventListener("click", async () => {
    try { const r = await fetch(b.getAttribute("data-copy-md")); await navigator.clipboard.writeText(await r.text()); b.textContent = "copied ✓"; }
    catch { b.textContent = "copy failed"; }
    setTimeout(() => (b.textContent = "copy as markdown"), 1800);
  }));
  // Live 402 demo: step 1 is a real request to this server; steps 2-3 show a recorded testnet sample.
  const run = document.getElementById("run-402");
  if (!run) return;
  const steps = [...document.querySelectorAll(".tx .step")];
  let ran = false;
  run.addEventListener("click", async () => {
    if (ran) return; ran = true; run.disabled = true; run.textContent = "running…";
    steps.forEach((s) => s.classList.add("pending"));
    const out = document.getElementById("live-402");
    try {
      const r = await fetch("/v1/extract?url=" + encodeURIComponent("https://example.com/"));
      const hdr = r.headers.get("PAYMENT-REQUIRED");
      const req = hdr ? JSON.parse(atob(hdr)) : null;
      const a = req && req.accepts[0];
      out.innerHTML = `<span class="s${r.status}">HTTP/1.1 ${r.status} ${r.status === 402 ? "Payment Required" : ""}</span>\n` +
        (a ? `<span class="k">scheme</span>   ${a.scheme}\n<span class="k">network</span>  ${a.network}  <span class="dim">(Base Sepolia)</span>\n<span class="k">amount</span>   ${a.amount}  <span class="dim">= $${(Number(a.amount)/1e6).toFixed(3)} USDC</span>\n<span class="k">asset</span>    ${a.asset.slice(0,10)}…${a.asset.slice(-4)}\n<span class="k">payTo</span>    ${a.payTo.slice(0,10)}…${a.payTo.slice(-4)}` : "(no challenge header)");
    } catch (e) { out.textContent = "request failed: " + e; }
    const reveal = (i, delay) => setTimeout(() => { steps[i].classList.remove("pending"); steps[i].classList.add("in"); }, reduce ? 0 : delay);
    reveal(0, 0); reveal(1, 600); reveal(2, 1200);
    setTimeout(() => { const l = document.querySelector(".top .logo"); if (l) l.classList.add("falling"); run.textContent = "done · ran once"; }, reduce ? 0 : 1250);
  });
})();
