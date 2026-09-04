import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedApiUrl,
  assertAllowedPageUrl,
  isAllowedApiUrl,
  isAllowedAttachmentHost,
  isAllowedLoginUrl,
  isAllowedPageUrl,
  isTrustedAttachmentCookieHost,
  redactUrlForLog,
} from "./urls.js";

test("credentials are restricted to exact HTTPS identity-provider origins", () => {
  for (const url of ["https://accounts.sap.com/login", "https://accounts.sap.cn/login", "https://accounts.sap.com:443/login"]) {
    assert.equal(isAllowedLoginUrl(url), true, url);
  }
  for (const url of [
    "https://me.sap.com/login",
    "https://campaign.sap.com/login",
    "https://sap.cn/login",
    "https://eu.accounts.sap.com/login",
    "https://accounts.sap.com:8443/login",
    "https://accounts.sap.com.evil.example/login",
    "https://user:secret@accounts.sap.com/login",
    "http://accounts.sap.com/login",
  ]) {
    assert.equal(isAllowedLoginUrl(url), false, url);
  }
});

test("page URLs allow the SAP portal and identity hosts", () => {
  for (const url of [
    "https://me.sap.com/notes/2170696",
    "https://accounts.sap.com/saml2/idp/sso",
    "https://eu.accounts.sap.com/login",
    "https://accounts.sap.cn/saml2/idp/sso",
    "https://launchpad.support.sap.com/#/notes/1",
  ]) {
    assert.equal(isAllowedPageUrl(url), true, url);
  }
});

test("page and login URLs reject http, file, foreign hosts and userinfo", () => {
  for (const url of [
    "http://me.sap.com/notes/1",
    "file:///etc/passwd",
    "https://evil.example/login",
    "https://notsap.com/x",
    "https://sap.com.evil.example/x",
    "https://evil@me.sap.com/login",
    "https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2",
    "not a url",
  ]) {
    assert.equal(isAllowedPageUrl(url), false, url);
    assert.equal(isAllowedLoginUrl(url), false, url);
  }
});

test("API URLs additionally allow Coveo, still reject everything else", () => {
  assert.equal(
    isAllowedApiUrl("https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2"),
    true,
  );
  assert.equal(isAllowedApiUrl("https://me.sap.com/backend/raw/coveo/CoveoToken"), true);
  assert.equal(isAllowedApiUrl("https://evil.example/search"), false);
  assert.equal(isAllowedApiUrl("http://org.coveo.com/rest/search/v2"), false);
});

test("attachment hosts stay on https sap.com (no coveo, no sap.cn, no userinfo)", () => {
  assert.equal(isAllowedAttachmentHost("https://me.sap.com/dl/1"), true);
  assert.equal(isAllowedAttachmentHost("https://launchpad.support.sap.com/x"), true);
  assert.equal(isAllowedAttachmentHost("https://sap.com/x"), true);
  assert.equal(isAllowedAttachmentHost("https://accounts.sap.cn/dl/1"), false);
  assert.equal(isAllowedAttachmentHost("https://org.coveo.com/dl/1"), false);
  assert.equal(isAllowedAttachmentHost("https://evil@me.sap.com/dl/1"), false);
  assert.equal(isAllowedAttachmentHost("https://sap.com.evil.example/x"), false);
});

test("attachment cookies are limited to portal hosts, not every sap.com subdomain", () => {
  assert.equal(isTrustedAttachmentCookieHost("https://me.sap.com/dl/1"), true);
  assert.equal(isTrustedAttachmentCookieHost("https://launchpad.support.sap.com/x"), true);
  assert.equal(isTrustedAttachmentCookieHost("https://support.sap.com/files/1"), true);
  assert.equal(isTrustedAttachmentCookieHost("https://accounts.sap.com/x"), true);
  assert.equal(isTrustedAttachmentCookieHost("https://campaign.sap.com/dl/1"), false);
  assert.equal(isTrustedAttachmentCookieHost("https://evil.example/x"), false);
  assert.equal(
    isTrustedAttachmentCookieHost("https://softwaredownloads.sap.com/x", [
      "softwaredownloads.sap.com",
    ]),
    true,
  );
});

test("redactUrlForLog strips query, hash and userinfo", () => {
  assert.equal(
    redactUrlForLog("https://me.sap.com/search?q=secret&token=abc#frag"),
    "https://me.sap.com/search?[redacted]",
  );
  assert.equal(redactUrlForLog("https://me.sap.com/notes/1"), "https://me.sap.com/notes/1");
});

test("assert helpers withhold rejected URLs and their credentials", () => {
  assert.throws(() => assertAllowedPageUrl("https://evil.example/x"), /Refusing navigation/);
  assert.throws(() => assertAllowedApiUrl("file:///etc/passwd"), /Refusing API request/);
  assert.doesNotThrow(() => assertAllowedPageUrl("https://me.sap.com/notes/1"));
  assert.doesNotThrow(() =>
    assertAllowedApiUrl("https://example.org.coveo.com/rest/search/v2"),
  );
});
