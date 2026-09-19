import { expect, test } from "@playwright/test";

test("홈 페이지가 200으로 응답하고 제품명을 표시한다", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("CodeGraph Reviewer");
  await expect(page.getByTestId("site-header")).toContainText("CodeGraph");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("요구사항");
});
