const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("access_token");
history.replaceState(null, "", "/anilist-callback");
const nonce = sessionStorage.getItem("nen-oauth-nonce");
sessionStorage.removeItem("nen-oauth-nonce");
if (token && nonce && params.get("state") === nonce && opener) {
  opener.postMessage({ token, nonce }, location.origin);
  document.querySelector("p").textContent = "You can close this tab.";
} else
  document.querySelector("p").textContent =
    "Sign-in failed. Close this tab and try again.";
