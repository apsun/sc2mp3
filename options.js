"use strict";

async function init() {
    let options = await browser.storage.sync.get("enableHQ");
    let enableHQ = options["enableHQ"];
    document.optionsForm.enableHQ.value = enableHQ ? "1" : "0";

    for (let radio of document.optionsForm.enableHQ) {
        radio.addEventListener("change", async (e) => {
            let val = e.target.value !== "0";
            await browser.storage.sync.set({
                "enableHQ": val
            });
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
