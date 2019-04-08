// TODO: Find a better way to get this. Currently this is just scraped
// from the SoundCloud page.
let clientId = "L6pWQKWWm6oT4Nv0mTWEkxKypNpleA5m";

// Takes a base URL and an object containing query params and
// generates a URL with the query params appended.
function withQuery(baseUrl, params) {
    let url = new URL(baseUrl);
    Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
    return url.toString();
}

// Gets the internal ID of a SoundCloud track given its user-friendly
// URL (e.g. https://soundcloud.com/choicescarf/departure-remix)
async function getTrackInfo(trackUrl) {
    let resp = await fetch(
        withQuery("https://api.soundcloud.com/resolve", {
            "url": trackUrl,
            "format": "json",
            "client_id": clientId,
        }), {
            "redirect": "follow"
        }
    );
    let json = await resp.json();
    return json;
}

// Gets the URL used to download the track with the given ID.
async function getTrackMp3Url(trackId) {
    let resp = await fetch(
        withQuery(`https://api.soundcloud.com/i1/tracks/${trackId}/streams`, {
            "client_id": clientId,
        })
    );
    let json = await resp.json();
    return json["http_mp3_128_url"];
}

// Initiates a download for the specified track.
async function downloadTrack(trackUrl) {
    let info = await getTrackInfo(trackUrl);
    let mp3Url = await getTrackMp3Url(info["id"]);

    // Generate a user-friendly name for the song.
    // Heuristic: if the title already contains a dash,
    // use that as the full name; otherwise prepend the
    // uploader's name.
    let name = info["title"]
    if (!name.includes("-")) {
        let artist = info["user"]["username"];
        name = `${artist} - ${name}`;
    }

    // a.download doesn't work with cross-origin requests;
    // since the file is hosted on a CDN we do an ugly workaround
    // with blob URLs which are exempt from the policy.
    let resp = await fetch(mp3Url);
    let blob = await resp.blob();
    let a = document.createElement("a");
    a.download = `${name}.mp3`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Guesses a track URL given a DOM element that may or
// may not be a track.
function getTrackUrlForElement(elem) {
    // Look for the closest container, which happens when the track
    // is not the single main track on the page.
    let container =
        elem.closest(".soundList__item") ||  // Stream
        elem.closest(".trackList__item") ||  // Sets
        elem.closest(".soundBadgeList__item");  // Sidebar

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
function initDownloadButton(elem) {
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
            await downloadTrack(trackUrl);
        };

        // Insert our download button into the page
        likeButton.parentNode.appendChild(button);
    }
}

// Begins listening for DOM events and immediately injects
// download buttons into the DOM. Must only be called after
// the DOM is ready.
function init() {
    let observer = new MutationObserver((mutations, observer) => {
        for (let mutation of mutations) {
            for (let elem of mutation.addedNodes) {
                initDownloadButton(elem);
            }
        }
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    initDownloadButton(document.body);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
