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

// Picks a transcoding matching the specified quality ("hq" or "sq")
// and protocol ("progressive" or "hls").
function pickTranscoding(trackObj, quality, protocol) {
    for (let transcoding of trackObj["media"]["transcodings"]) {
        if (transcoding["format"]["protocol"] !== protocol) {
            continue;
        }
        if (transcoding["quality"] !== quality) {
            continue;
        }
        return transcoding;
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
        let artist = trackObj["publisher_metadata"]?.["artist"] ??
            trackObj["user"]["username"];
        name = `${artist} - ${name}`;
    }
    return name;
}

// Ghetto non-compliant HLS playlist parser that just returns
// all the segment URLs.
function getHlsSegmentUrls(m3u8) {
    if (!m3u8.startsWith("#EXTM3U")) {
        throw new Error("Invalid HLS playlist file");
    }
    let uris = [];
    let lines = m3u8.split(/\r?\n/);
    for (let line of lines) {
        if (line === "") {
            continue;
        }
        if (line[0] === "#") {
            // EXT-X-MAP tag points to the file header, other parts
            // of the file are just plain links
            let match = line.match(/^#EXT-X-MAP:URI="(.+?)"/);
            if (match !== null) {
                uris.push(match[1]);
            }
            continue;
        }
        uris.push(line);
    }
    return uris;
}

// Given a list of URLs pointing to blobs, downloads all of
// them and merges them into a single resulting blob.
async function downloadAndMergeSegments(urls) {
    let segments = await Promise.all(
        urls.map((u) => fetch(u).then((r) => r.blob()))
    );
    return new Blob(segments);
}

// Initiates a download for the specified track using one of
// the transcoded versions (as opposed to the original).
async function downloadTrackTranscoding(trackObj, authToken) {
    // Pick a transcoding, preferring HQ > SQ and progressive
    // over HLS
    let transcoding =
        pickTranscoding(trackObj, "hq", "progressive") ||
        pickTranscoding(trackObj, "hq", "hls") ||
        pickTranscoding(trackObj, "sq", "progressive") ||
        pickTranscoding(trackObj, "sq", "hls");
    if (transcoding === null) {
        let transcodings = trackObj["media"]["transcodings"];
        let options = transcodings.map(
            (t) => (`protocol=${t["format"]["protocol"]}, quality=${t["quality"]}`)
        );
        throw new Error(`Failed to find a valid transcoding (options: ${options.join("; ")})`);
    }

    // One more level of indirection here...
    let urlResp = await fetchAuthorizedJson(transcoding["url"], authToken, {});
    let url = urlResp["url"];

    // If this is a progressive ("direct") link, download the track
    // directly. Otherwise, download the HLS playlist as text and
    // then download the chunks.
    let resp = await fetch(url);
    let blob;
    if (transcoding["format"]["protocol"] === "progressive") {
        blob = await resp.blob();
    } else if (transcoding["format"]["protocol"] === "hls") {
        let m3u8 = await resp.text();
        let segments = getHlsSegmentUrls(m3u8);
        blob = await downloadAndMergeSegments(segments);

        // Original URL points to the m3u8 file, so replace it with
        // one of the segment URLs so we can accurately determine
        // the file extension.
        url = segments[0];
    }

    // Build filename from track name and extension of file URL.
    // HQ files are .m4a, SQ files are .mp3
    let name = getTrackName(trackObj);
    let path = new URL(url).pathname;
    let extension = path.substring(path.lastIndexOf(".") + 1);
    let filename = `${name}.${extension}`;

    // a.download doesn't work with cross-origin requests;
    // since the file is hosted on a CDN we do an ugly workaround
    // with blob URLs which are exempt from the policy.
    downloadUrl(URL.createObjectURL(blob), filename);
}

// Initiates a download for the specified track using the
// native download option.
async function downloadNative(trackId, authToken) {
    let json = await fetchAuthorizedJson(
        `https://api-v2.soundcloud.com/tracks/${trackId}/download`,
        authToken
    );
    let url = json["redirectUri"];
    downloadUrl(url);
}

// Initiates a download for the specified track URL.
async function downloadTrack(trackUrl) {
    // If we want to download in HQ, read the auth cookie so
    // we can see HQ transcodings
    let authToken = null;
    if (typeof chrome !== "undefined" && chrome.storage) {
        let settings = await chrome.storage.sync.get("enableHQ");
        if (settings["enableHQ"]) {
            authToken = getCookie("oauth_token");
        }
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
    // the original download button behavior. This now requires
    // authentication, so only do it if we have the OAuth token.
    if (trackObj["downloadable"] &&
        trackObj["has_downloads_left"] &&
        authToken !== null)
    {
        return await downloadNative(trackObj["id"], authToken);
    }

    return await downloadTrackTranscoding(trackObj, authToken);
}

// Guesses a track URL given a DOM element that may or
// may not be associated with a track.
function getTrackUrlForElement(elem) {
    let trackUrl = null;

    // Look for the closest container, which happens when the track
    // is not the single main track on the page.
    let container =
        elem.closest(".compactTrackList__item") ||
        elem.closest(".trackList__item") ||
        elem.closest(".soundList__item") ||
        elem.closest(".badgeList__item") ||
        elem.closest(".soundBadgeList__item") ||
        elem.closest(".historicalPlays__item") ||
        elem.closest(".searchList__item") ||
        null;

    // If the item is in a container, look for a clickable title within
    // the container.
    if (container !== null) {
        let title =
            container.querySelector(".soundTitle__title") ||
            container.querySelector(".trackItem__trackTitle") ||
            container.querySelector(".playableTile__mainHeading");

        if (title !== null && title.tagName === "A") {
            trackUrl = title.href;
        }
    }

    // Otherwise, fallback to the page URL
    if (trackUrl === null) {
        trackUrl = window.location.href;
    }

    // Remove query string (breaks the /resolve endpoint)
    trackUrl = trackUrl.split("?")[0];

    // Convert soundcloud.com/n/x -> soundcloud.com/x
    // (used by the new player iframe)
    trackUrl = trackUrl.replace("/n/", "/");

    // Only allow paths in the format /<artist>/<track>
    let blacklist = ["discover", "feed", "you"];
    let path = new URL(trackUrl).pathname.split("/");
    if (path.length !== 3 || blacklist.includes(path[1])) {
        return null;
    }

    return trackUrl;
}

// Adds download buttons to all action bars under the given element
// that do not already have them.
function injectDownloadButton(elem) {
    const oldDownloadSvg = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.47-7.53l1.06 1.06L8 13.06 3.47 8.53l1.06-1.06 2.72 2.72V3h1.5v7.19l2.72-2.72z" fill="currentColor"></path></svg>';
    const oldDotDotSvg = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 8c0-.832-.67-1.5-1.511-1.5C1.67 6.5 1 7.168 1 8s.67 1.5 1.489 1.5C3.33 9.5 4 8.832 4 8zm5.5 0c0-.832-.67-1.5-1.504-1.5C7.17 6.5 6.5 7.168 6.5 8s.67 1.5 1.496 1.5C8.831 9.5 9.5 8.832 9.5 8zM15 8c0-.832-.664-1.5-1.493-1.5C12.664 6.5 12 7.168 12 8s.664 1.5 1.507 1.5C14.336 9.5 15 8.832 15 8z" fill="currentColor"></path></svg>';
    const newDownloadSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12.75 3v15.44l5.5-5.5L19.31 14 12 21.31 4.69 14l1.06-1.06 5.5 5.5V3h1.5Z" clip-rule="evenodd"></path></svg>';
    const newDotDotSvg = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 12C8 12.8284 7.32843 13.5 6.5 13.5C5.67157 13.5 5 12.8284 5 12C5 11.1716 5.67157 10.5 6.5 10.5C7.32843 10.5 8 11.1716 8 12Z" fill="currentColor"></path><path d="M13.5 12C13.5 12.8284 12.8284 13.5 12 13.5C11.1716 13.5 10.5 12.8284 10.5 12C10.5 11.1716 11.1716 10.5 12 10.5C12.8284 10.5 13.5 11.1716 13.5 12Z" fill="currentColor"></path><path d="M17.5 13.5C18.3284 13.5 19 12.8284 19 12C19 11.1716 18.3284 10.5 17.5 10.5C16.6716 10.5 16 11.1716 16 12C16 12.8284 16.6716 13.5 17.5 13.5Z" fill="currentColor"></path></svg>';

    // Sometimes we get text nodes from MutationObserver
    if (!(elem instanceof HTMLElement)) {
        return;
    }

    // Find all like buttons (old design, main page)
    let likeButtons = elem.querySelectorAll("button.sc-button-like");
    for (let likeButton of likeButtons) {
        let container = likeButton.parentNode;
        if (container.querySelector("button.sc-button-download") !== null) {
            continue;
        }

        let trackUrl = getTrackUrlForElement(likeButton);
        if (trackUrl === null) {
            continue;
        }

        let icon = document.createElement("div");
        icon.innerHTML = oldDownloadSvg;

        let likeLabel = likeButton.querySelector("span.sc-button-label");
        let label = document.createElement("span");
        label.innerText = "Download";
        label.className = likeLabel.className;

        let button = document.createElement("button");
        button.className = likeButton.className.replace(
            "sc-button-like",
            "sc-button-download"
        );
        button.classList.remove("sc-button-selected");
        button.title = "Download (sc2mp3)";
        button.ariaLabel = "Download track";
        button.appendChild(icon);
        button.appendChild(label);

        button.onclick = async (e) => {
            try {
                button.classList.add("sc-button-selected");
                icon.innerHTML = oldDotDotSvg;
                label.innerText = "Downloading...";
                button.appendChild(label);
                await downloadTrack(trackUrl);
            } catch (ex) {
                alert(ex.toString() + "\n\n" + ex.stack);
                throw ex;
            } finally {
                button.classList.remove("sc-button-selected");
                icon.innerHTML = oldDownloadSvg;
                label.innerText = "Download";
                button.appendChild(label);
            }
        };
        container.insertBefore(button, likeButton.nextSibling);
    }

    // Find all share buttons (new design, player iframe)
    let shareButtons = elem.querySelectorAll("button[aria-label='Share']");
    for (let shareButton of shareButtons) {
        let container = shareButton.parentNode;
        if (container.querySelector("button[aria-label='Download track']") !== null) {
            continue;
        }

        let trackUrl = getTrackUrlForElement(shareButton);
        if (trackUrl === null) {
            continue;
        }

        let button = document.createElement("button");
        button.className = shareButton.className;
        button.title = "Download (sc2mp3)";
        button.ariaLabel = "Download track";
        button.innerHTML = newDownloadSvg;
        button.onclick = async (e) => {
            try {
                button.innerHTML = newDotDotSvg;
                await downloadTrack(trackUrl);
            } catch (ex) {
                alert(ex.toString() + "\n\n" + ex.stack);
                throw ex;
            } finally {
                button.innerHTML = newDownloadSvg;
            }
        };
        container.insertBefore(button, shareButton.nextSibling);
    }
}

// Gets the client ID from the current page. Must only be called
// after the DOM is ready.
async function scrapeClientId() {
    // Script isn't available in the player iframe, so walk up to
    // the parent page
    let win = window;
    while (win.parent !== win) {
        win = win.parent;
    }

    // This code makes me want to gouge out my eyes!
    // It loads every .js file in the page, and SEARCHES THROUGH
    // THE SOURCE CODE WITH A REGEX for the client ID!
    // It's totally insane, but it works, so...
    for (let script of win.document.getElementsByTagName("script")) {
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
    try {
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
    } catch (ex) {
        alert("Failed to initialize sc2mp3: " + ex.toString() + "\n\n" + ex.stack);
        throw ex;
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
