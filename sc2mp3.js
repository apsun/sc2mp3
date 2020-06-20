"use strict";

// SoundCloud client ID used for API requests.
let clientId;

// Takes a base URL and an object containing query params and
// generates a URL with the query params appended.
function withQuery(baseUrl, params) {
    let url = new URL(baseUrl);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    return url.toString();
}

// Wrapper for fetch() that takes a query parameter and adds
// it to the URL, and returns the result as JSON.
async function fetchJson(url, init) {
    if (init !== null && init["query"] !== undefined) {
        url = withQuery(url, init["query"]);
        delete init["query"];
    }
    let resp = await fetch(url, init);
    if (!resp.ok) {
        throw new Error(`Request to ${url} failed with result ${resp.status}`);
    }
    let json = await resp.json();
    return json;
}

// Wrapper for fetchJson() that adds the clientId and
// authToken parameters.
async function fetchAuthorizedJson(url, authToken, args) {
    let headers = {};
    if (authToken !== null) {
        headers["Authorization"] = "OAuth " + authToken;
    }

    let query = {
        "client_id": clientId,
        ...args
    };

    return await fetchJson(url, {
        "headers": headers,
        "query": query,
    });
}

// Returns the value of the specified cookie, or null if the
// cookie is not set.
function getCookie(key) {
    let match = document.cookie.match(new RegExp("(^|;) *" + key + "=([^;]+)"));
    if (match !== null) {
        return match[2];
    }
    return null;
}

// Initiates a download for the specified URL, optionally
// specifying a filename if the URL is not cross-origin.
function downloadUrl(url, filename) {
    let a = document.createElement("a");
    a.download = filename;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Picks a transcoding matching the specified quality ("hq" or "sq").
function pickTranscoding(trackObj, quality) {
    // SoundCloud has two formats - a HLS streaming playlist and
    // a plain old music file ("progressive"). Obviously, we want
    // to pick the easier method, so use progressive formats.
    for (let transcoding of trackObj["media"]["transcodings"]) {
        if (transcoding["format"]["protocol"] !== "progressive") {
            continue;
        }
        if (transcoding["quality"] === quality) {
            return transcoding;
        }
    }
    return null;
}

// Generates a user-friendly name for the given track.
function getTrackName(trackObj) {
    // Heuristic: if the title already contains a dash,
    // use that as the full name; otherwise prepend the
    // uploader's name.
    let name = trackObj["title"];
    if (!name.includes(" - ")) {
        let artist = trackObj["user"]["username"];
        name = `${artist} - ${name}`;
    }
    return name;
}

// Initiates a download for the specified track using one of
// the transcoded versions (as opposed to the original).
async function downloadTrackTranscoding(trackObj, authToken) {
    // Pick a transcoding, preferring HQ obviously
    let transcoding =
        pickTranscoding(trackObj, "hq") ||
        pickTranscoding(trackObj, "sq");
    if (transcoding === null) {
        throw new Error("Failed to find a valid transcoding");
    }

    // One more level of indirection here...
    let urlResp = await fetchAuthorizedJson(transcoding["url"], authToken, {});
    let url = urlResp["url"];

    // Build filename from track name and extension of file URL.
    // HQ files are .m4a, SQ files are .mp3
    let name = getTrackName(trackObj);
    let path = new URL(url).pathname;
    let extension = path.substring(path.lastIndexOf(".") + 1);
    let filename = `${name}.${extension}`;

    // a.download doesn't work with cross-origin requests;
    // since the file is hosted on a CDN we do an ugly workaround
    // with blob URLs which are exempt from the policy.
    let resp = await fetch(url);
    let blob = await resp.blob();
    downloadUrl(URL.createObjectURL(blob), filename);
}

// Initiates a download for the specified track using the
// native download option.
async function downloadNative(trackId) {
    let json = await fetchAuthorizedJson(
        `https://api-v2.soundcloud.com/tracks/${trackId}/download`,
        null
    );
    let url = json["redirectUri"];
    downloadUrl(url);
}

// Initiates a download for the specified track URL.
async function downloadTrack(trackUrl) {
    // If we want to download in HQ, read the auth cookie so
    // we can see HQ transcodings
    let authToken = null;
    let settings = await browser.storage.sync.get("enableHQ");
    if (settings["enableHQ"]) {
        authToken = getCookie("oauth_token");
    }

    // Resolve the track URL to a track object
    let trackObj = await fetchAuthorizedJson(
        "https://api-v2.soundcloud.com/resolve",
        authToken,
        {
            "url": trackUrl,
        }
    );

    // If the track is natively downloadable, just replicate
    // the original download button behavior.
    if (trackObj["downloadable"] && trackObj["has_downloads_left"]) {
        return await downloadNative(trackObj["id"]);
    }

    return await downloadTrackTranscoding(trackObj, authToken);
}

// Guesses a track URL given a DOM element that may or
// may not be a track.
function getTrackUrlForElement(elem) {
    // Look for the closest container, which happens when the track
    // is not the single main track on the page.
    let container =
        elem.closest(".soundList__item") ||  // Stream
        elem.closest(".trackList__item") ||  // Sets
        elem.closest(".soundBadgeList__item") ||  // Likes sidebar
        elem.closest(".historicalPlays__item");  // History sidebar

    // This item is in a list, now look for a clickable title within
    // the container.
    if (container !== null) {
        let title =
            container.querySelector(".soundTitle__title") ||
            container.querySelector(".trackItem__trackTitle");

        if (title !== null && title.tagName === "A") {
            return title.href;
        }
    }

    // Default to the page URL
    return window.location.href;
}

// Adds download buttons to all action bars under the given element
// that do not already have them.
function injectDownloadButton(elem) {
    // Sometimes we get text nodes from MutationObserver
    if (!(elem instanceof HTMLElement)) {
        return;
    }

    // Find all the action bars under this element.
    let actionDivs = elem.querySelectorAll(".soundActions");
    for (let actionDiv of actionDivs) {
        // Check that we don't already have a download button
        if (actionDiv.querySelector(".sc-button-download") !== null) {
            continue;
        }

        // We're going to copy the style from the like button,
        // so assume it exists
        let likeButton = actionDiv.querySelector(".sc-button-like");
        if (likeButton === null) {
            continue;
        }

        // Figure out what track this button set corresponds to,
        // skip "tracks" that are actually sets
        let trackUrl = getTrackUrlForElement(actionDiv);
        if (new URL(trackUrl).pathname.includes("/sets/")) {
            continue;
        }

        // Create our download button
        let button = document.createElement("button");
        button.className = likeButton.className.replace(
            "sc-button-like",
            "sc-button-download"
        );
        button.classList.remove("sc-button-selected");
        button.innerText = "Download";
        button.title = "Download";
        button.onclick = async (e) => {
            button.innerText = "Downloading...";
            button.classList.add("sc-button-selected");
            try {
                await downloadTrack(trackUrl);
                button.innerText = "Download";
            } catch (ex) {
                button.innerText = "Failed :-(";
                alert(ex.toString());
                throw ex;
            } finally {
                button.classList.remove("sc-button-selected");
            }
        };

        // Insert our download button into the page
        likeButton.parentNode.appendChild(button);
    }
}

// Gets the client ID from the current page. Must only be called
// after the DOM is ready.
async function scrapeClientId() {
    // This code makes me want to gouge out my eyes!
    // It loads every .js file in the page, and SEARCHES THROUGH
    // THE SOURCE CODE WITH A REGEX for the client ID!
    // It's totally insane, but it works, so...
    for (let script of document.getElementsByTagName("script")) {
        if (script.src === "") {
            continue;
        }

        let resp;
        try {
            resp = await fetch(script.src);
        } catch (ex) {
            continue;
        }

        let src = await resp.text();
        let match = src.match(/client_id:["']([A-Za-z0-9]{32})['"]/);
        if (match !== null) {
            let clientId = match[1];
            return clientId;
        }
    }

    throw new Error("Could not get client_id value from current page");
}

// Begins listening for DOM events and immediately injects
// download buttons into the DOM. Must only be called after
// the DOM is ready.
async function init() {
    clientId = await scrapeClientId();

    let observer = new MutationObserver((mutations, observer) => {
        for (let mutation of mutations) {
            for (let elem of mutation.addedNodes) {
                injectDownloadButton(elem);
            }
        }
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    injectDownloadButton(document.body);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
