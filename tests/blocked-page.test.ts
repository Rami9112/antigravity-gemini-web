import { describe, expect, it } from "vitest";
import { describeBlockedPage } from "../src/driver/gemini-web-driver.js";

describe("describeBlockedPage", () => {
  it("detects Google's unusual-traffic CAPTCHA interstitial", () => {
    const url =
      "https://www.google.com/sorry/index?continue=https://gemini.google.com/app&q=EgQxo_mnGIHT0NYG";
    expect(describeBlockedPage(url)).toContain("CAPTCHA");
  });

  it("detects the Google sign-in page", () => {
    expect(
      describeBlockedPage("https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp"),
    ).toContain("sign-in");
  });

  it("treats normal Gemini Web pages and non-URLs as healthy", () => {
    expect(describeBlockedPage("https://gemini.google.com/app")).toBeNull();
    expect(describeBlockedPage("https://gemini.google.com/app/69fbdc50978dc242")).toBeNull();
    expect(describeBlockedPage("http://127.0.0.1:5000/sorry")).toBeNull();
    expect(describeBlockedPage("about:blank")).toBeNull();
  });
});
