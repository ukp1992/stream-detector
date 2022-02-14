"use strict";

import defaults from "./components/defaults.js";
import supported from "./components/supported.js";
import { getStorage, setStorage, clearStorage } from "./components/storage.js";

const _ = chrome.i18n.getMessage;

let urlStorage = [];
let urlStorageRestore = [];
let badgeText = 0;
let queue = [];

let subtitlePref;
let filePref;
let manifestPref;
let blacklistPref;
let blacklistEntries;
let customExtPref;
let customCtPref;
let cleanupPref;
let disablePref;
const customSupported = { ext: [], ct: [], type: "CUSTOM", category: "custom" };

const init = async () => {
	for (const option in defaults) {
		if ((await getStorage(option)) === null)
			// write defaults to storage
			await setStorage({ [option]: defaults[option] });
	}

	setStorage({ version: chrome.runtime.getManifest().version });

	// newline shouldn't really be an issue but just in case
	chrome.runtime.getPlatformInfo(async (info) => {
		if (info.os === "win") setStorage({ newline: "\r\n" });
		else setStorage({ newline: "\n" });
	});
};

const getTabData = async (tab) =>
	new Promise((resolve) => chrome.tabs.get(tab, (data) => resolve(data)));

const updateVars = async () => {
	// the web storage api crashes the entire browser sometimes so I have to resort to this nonsense
	subtitlePref = await getStorage("subtitlePref");
	filePref = await getStorage("filePref");
	manifestPref = await getStorage("manifestPref");
	blacklistPref = await getStorage("blacklistPref");
	blacklistEntries = await getStorage("blacklistEntries");
	customExtPref = await getStorage("customExtPref");
	customSupported.ext = await getStorage("customExtEntries");
	customCtPref = await getStorage("customCtPref");
	customSupported.ct = await getStorage("customCtEntries");
	cleanupPref = await getStorage("cleanupPref");
	disablePref = await getStorage("disablePref");
};

const urlFilter = (requestDetails) => {
	let e;

	if (requestDetails.requestHeaders) {
		const url = new URL(requestDetails.url).pathname.toLowerCase();
		// go through the extensions and see if the url contains any
		e =
			customExtPref === true &&
			customSupported.ext.length > 0 &&
			customSupported.ext.some((fe) => url.includes("." + fe)) &&
			customSupported;
		if (!e)
			e = supported.find((f) => f.ext.some((fe) => url.includes("." + fe)));
	} else if (requestDetails.responseHeaders) {
		const header = requestDetails.responseHeaders.find(
			(h) => h.name.toLowerCase() === "content-type"
		);
		if (header)
			// go through content types and see if the header matches
			e =
				customCtPref === true &&
				customSupported.ct.length > 0 &&
				customSupported.ct.includes(header.value.toLowerCase()) &&
				customSupported;
		if (!e)
			e = supported.find((f) => f.ct.includes(header.value.toLowerCase()));
	}

	if (
		e &&
		!urlStorage.find((u) => u.url === requestDetails.url) && // urlStorage because promises are too slow sometimes
		!queue.includes(requestDetails.requestId) && // queue in case urlStorage is also too slow
		(!subtitlePref || (subtitlePref && e.category !== "subtitles")) &&
		(!filePref || (filePref && e.category !== "files")) &&
		(!manifestPref || (manifestPref && e.category !== "stream")) &&
		(!blacklistPref ||
			(blacklistPref &&
				blacklistEntries?.filter(
					(entry) =>
						requestDetails.url?.includes(entry) ||
						(
							requestDetails.documentUrl ||
							requestDetails.originUrl ||
							requestDetails.initiator
						)?.includes(entry)
				).length === 0))
	) {
		queue.push(requestDetails.requestId);
		requestDetails.type = e.type;
		requestDetails.category = e.category;
		addURL(requestDetails);
	}
};

const addURL = async (requestDetails) => {
	const url = new URL(requestDetails.url);

	// MSS workaround
	const urlPath = url.pathname.toLowerCase().includes(".ism/manifest")
		? url.pathname.slice(0, url.pathname.lastIndexOf("/"))
		: url.pathname;

	// eslint-disable-next-line no-nested-ternary
	const filename = +urlPath.lastIndexOf("/")
		? urlPath.slice(urlPath.lastIndexOf("/") + 1)
		: urlPath[0] === "/"
		? urlPath.slice(1)
		: urlPath;

	const { hostname } = url;
	// depends on which listener caught it
	const headers =
		requestDetails.requestHeaders || requestDetails.responseHeaders;

	const tabData = await getTabData(requestDetails.tabId);

	// web storage api optimization
	const newRequestDetails = {
		category: requestDetails.category,
		documentUrl: requestDetails.documentUrl,
		originUrl: requestDetails.originUrl,
		initiator: requestDetails.initiator,
		requestId: requestDetails.requestId,
		tabId: requestDetails.tabId,
		timeStamp: requestDetails.timeStamp,
		type: requestDetails.type,
		url: requestDetails.url,
		headers: headers?.filter(
			(h) =>
				h.name.toLowerCase() === "user-agent" ||
				h.name.toLowerCase() === "referer"
		),
		filename,
		hostname,
		tabData: { title: tabData?.title, url: tabData?.url }
	};
	urlStorage.push(newRequestDetails);

	badgeText = urlStorage.length;
	chrome.browserAction.setBadgeBackgroundColor({ color: "green" });
	chrome.browserAction.setBadgeText({
		text: badgeText.toString()
	});

	await setStorage({ urlStorage });

	chrome.runtime.sendMessage({ urlStorage: true }); // update popup if opened
	queue = queue.filter((q) => q !== requestDetails.requestId); // processing finished - remove from queue

	if (
		(await getStorage("notifDetectPref")) === false &&
		(await getStorage("notifPref")) === false
	) {
		chrome.notifications.create("add", {
			// id = only one notification of this type appears at a time
			type: "basic",
			iconUrl: "img/icon-dark-96.png",
			title: _("notifTitle"),
			message: _("notifText", requestDetails.type) + filename
		});
	}
};

const deleteURL = async (message) => {
	// url deletion
	if (message.previous === false) {
		urlStorage = urlStorage.filter(
			(url) =>
				!message.delete
					.map((msgUrl) => msgUrl.requestId)
					.includes(url.requestId)
		);
		badgeText = urlStorage.length;
	} else {
		urlStorageRestore = urlStorageRestore.filter(
			(url) =>
				!message.delete
					.map((msgUrl) => msgUrl.requestId)
					.includes(url.requestId)
		);
	}

	await setStorage({ urlStorage });
	await setStorage({ urlStorageRestore });
	chrome.runtime.sendMessage({ urlStorage: true });
	if (message.previous === false)
		chrome.browserAction.setBadgeText({
			text: badgeText === 0 ? "" : badgeText.toString() // only display at 1+
		});
};

(async () => {
	// clear everything and/or set up
	chrome.browserAction.setBadgeText({ text: "" });

	// cleanup for major updates
	const manifestVersion = chrome.runtime.getManifest().version;
	const addonVersion = await getStorage("version");
	if (
		(addonVersion &&
			(addonVersion.split(".")[0] < manifestVersion.split(".")[0] ||
				(addonVersion.split(".")[0] === manifestVersion.split(".")[0] &&
					addonVersion.split(".")[1] < manifestVersion.split(".")[1]))) ||
		!addonVersion
	) {
		// only when necessary
		await clearStorage();
	}

	await init();
	await updateVars();

	if (disablePref === false) {
		chrome.webRequest.onBeforeSendHeaders.addListener(
			urlFilter,
			{ urls: ["<all_urls>"] },
			["requestHeaders"]
		);
		chrome.webRequest.onHeadersReceived.addListener(
			urlFilter,
			{ urls: ["<all_urls>"] },
			["responseHeaders"]
		);
	}

	urlStorage = await getStorage("urlStorage");
	urlStorageRestore = await getStorage("urlStorageRestore");

	// restore urls on startup
	if (urlStorage && urlStorage.length > 0)
		urlStorageRestore = [...urlStorageRestore, ...urlStorage];

	if (urlStorageRestore && urlStorageRestore.length > 0) {
		if (cleanupPref)
			urlStorageRestore = urlStorageRestore.filter(
				(url) => new Date().getTime() - url.timeStamp < 604800000
			);

		await setStorage({ urlStorageRestore });
		await setStorage({ urlStorage: [] });
	}

	chrome.runtime.onMessage.addListener(async (message) => {
		if (message.delete) deleteURL(message);
		else if (message.options) {
			await updateVars();
			if (
				disablePref === true &&
				chrome.webRequest.onBeforeSendHeaders.hasListener(urlFilter) &&
				chrome.webRequest.onHeadersReceived.hasListener(urlFilter)
			) {
				chrome.webRequest.onBeforeSendHeaders.removeListener(urlFilter);
				chrome.webRequest.onHeadersReceived.removeListener(urlFilter);
			} else if (
				disablePref !== true &&
				!chrome.webRequest.onBeforeSendHeaders.hasListener(urlFilter) &&
				!chrome.webRequest.onHeadersReceived.hasListener(urlFilter)
			) {
				chrome.webRequest.onBeforeSendHeaders.addListener(
					urlFilter,
					{ urls: ["<all_urls>"] },
					["requestHeaders"]
				);
				chrome.webRequest.onHeadersReceived.addListener(
					urlFilter,
					{ urls: ["<all_urls>"] },
					["responseHeaders"]
				);
			}
		} else if (message.reset) {
			await clearStorage();
			await init();
			await updateVars();
			chrome.runtime.sendMessage({ options: true });
		}
	});

	chrome.commands.onCommand.addListener((cmd) => {
		if (cmd === "open-popup") chrome.browserAction.openPopup();
	});
})();
