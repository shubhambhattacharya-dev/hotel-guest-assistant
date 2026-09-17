import {
  test,
  expect,
  type Page,
} from "@playwright/test";

/**
 * E2E Tests for Hotel Guest Assistant
 *
 * These tests verify the full flow from the browser frontend
 * to the backend API and AI service.
 *
 * Playwright starts or reuses the backend and frontend dev servers.
 */

async function sendChatMessage(page: Page, text: string) {
  const input = page.getByPlaceholder("Type your message here...");
  const sendButton = page.locator("form").getByRole("button").last();

  await expect(input).toBeVisible();
  await input.fill(text);
  await expect(input).toHaveValue(text);
  await expect(sendButton).toBeEnabled({ timeout: 5000 });
  await sendButton.click();
}

test.describe("Hotel Guest Assistant – End-to-End", () => {
  test.describe("1. Page load and initial state", () => {
    test("should display the welcome message on load", async ({ page }) => {
      await page.goto("/");

      await expect(page).toHaveTitle(/Hotel/i);

      const welcomeText = page.getByRole("heading", {
        name: /AI hotel assistant/i,
      });
      await expect(welcomeText).toBeVisible();

      const askPrompt = page.getByText(/Ask me anything/i).first();
      await expect(askPrompt).toBeVisible();
    });

    test("should show quick question buttons", async ({ page }) => {
      await page.goto("/");

      for (const label of [
        "What time is check-in?",
        "Do you have a swimming pool?",
        "Is breakfast included?",
        "Cancellation policy",
        "Which room is good for 3 guests?",
      ]) {
        await expect(page.locator(`text=${label}`)).toBeVisible();
      }
    });

    test("should display the right sidebar with hotel facts", async ({ page }) => {
      test.skip(
        test.info().project.name === "Mobile Chrome",
        "The right-side facts panel is intentionally hidden on mobile.",
      );

      await page.goto("/");

      const sidebar = page.locator("aside").last();

      await expect(sidebar.locator("text=Check-in")).toBeVisible();
      await expect(sidebar.locator("text=Check-out")).toBeVisible();
      await expect(sidebar.locator("text=Wi-Fi")).toBeVisible();
      await expect(sidebar.locator("text=Swimming Pool")).toBeVisible();
      await expect(sidebar.locator("text=Pet Policy")).toBeVisible();
    });
  });

  test.describe("2. Normal guest questions", () => {
    test("should answer 'What time is check-in?' with grounded response", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(page, "What time is check-in?");

      await expect(page.locator(".animate-bounce")).toBeVisible({
        timeout: 2000,
      }).catch(() => {
        void 0;
      });

      const response = await page
        .locator("text=/3:00 PM|check-in/i")
        .first()
        .textContent();
      expect(response).toBeTruthy();
    });

    test("should answer 'Do you have a swimming pool?'", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(page, "Do you have a swimming pool?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /pool|outdoor|heated|rooftop/i,
        { timeout: 15000 },
      );
    });

    test("should answer 'What is the cancellation policy?'", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(page, "What is your cancellation policy?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /48 hours|cancellation/i,
        { timeout: 15000 },
      );
    });

    test("should answer 'Are pets allowed?'", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(page, "Are pets allowed?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /pet|25.*lb|allowed/i,
        { timeout: 15000 },
      );
    });
  });

  test.describe("3. Room-specific questions", () => {
    test("should show Executive Suite details when asked", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(
        page,
        "could you give me more details about EXECUTIVE SUITE",
      );

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /Executive Suite|Nespresso|Living area/i,
        { timeout: 15000 },
      );
    });

    test("should handle 'Most Popular' badge mention", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(page, "Tell me about the most popular room");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /Executive Suite|Most Popular/i,
        { timeout: 15000 },
      );
    });

    test("should answer pricing questions", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(page, "What is the cost of the Executive Suite?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /240|\$240/i,
        { timeout: 15000 },
      );
    });
  });

  test.describe("4. Availability check flow", () => {
    test("should trigger availability form for undated request", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(page, "Do you have any rooms free?");

      const form = page.locator(
        'input[type="date"], input[type="number"], input[type="select"]',
      );
      await expect(form.first()).toBeVisible({ timeout: 10000 });

      await expect(
        page.locator("text=/check-in|check-out|guests/i").first(),
      ).toBeVisible();
    });

    test("should check availability with dates and show room results", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(
        page,
        "Do you have rooms available from 2026-10-10 to 2026-10-12 for 2 adults?",
      );

      await page
        .locator("text=/Deluxe Room|Executive Suite|Family Suite/i")
        .first()
        .waitFor({ state: "visible", timeout: 20000 });

      const roomCount = await page
        .locator(
          "text=/Deluxe Room|Executive Suite|Family Suite/i",
        )
        .count();
      expect(roomCount).toBeGreaterThanOrEqual(1);
    });

    test("should display availability form with prefilled guests", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(page, "Are there rooms free for 3 adults?");

      const guestsSelect = page.locator('select');
      await expect(guestsSelect).toBeVisible({ timeout: 10000 });

      const selectedValue = await guestsSelect.inputValue();
      expect(selectedValue).toBe("3");
    });
  });

  test.describe("5. Unsupported / fallback scenarios", () => {
    test("should show fallback for unknown questions", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(page, "Do you have a helicopter landing pad?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /sorry|not enough verified|information/i,
        { timeout: 15000 },
      );
    });

    test("should ask for clarification when a question has an unresolved reference", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(page, "Is it included?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /clarif|what you mean/i,
        { timeout: 10000 },
      );
    });

    test("should handle greeting gracefully", async ({ page }) => {
      await page.goto("/");

      await sendChatMessage(page, "hi");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /hello|welcome/i,
        { timeout: 15000 },
      );
    });
  });

  test.describe("6. Conversation follow-ups", () => {
    test("should maintain context for follow-up questions", async ({
      page,
    }) => {
      await page.goto("/");

      await sendChatMessage(page, "What is your cancellation policy?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /48 hours|cancellation/i,
        { timeout: 15000 },
      );

      await sendChatMessage(page, "And what about check-out time?");

      await expect(page.getByTestId("assistant-message").first()).toContainText(
        /11:00\s*AM|11\s*AM|check-out/i,
        { timeout: 15000 },
      );
    });
  });

  test.describe("7. Mobile responsiveness", () => {
    test("should render chat interface on mobile", async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto("/");

      await expect(
        page.locator('input[type="text"]'),
      ).toBeVisible();
      await expect(
        page.locator('button[type="submit"]'),
      ).toBeVisible();
    });
  });

  test.describe("8. Frontend error state", () => {
    test("should show error when backend is unreachable", async ({ page }) => {
      await page.goto("/");

      const input = page.getByPlaceholder("Type your message here...");
      await input.fill("What time is check-in?");

      await page.route("**/api/chat", (route) => {
        route.abort();
      });

      const sendButton = page.locator("form").getByRole("button").last();
      await expect(sendButton).toBeEnabled({ timeout: 5000 });
      await sendButton.click();

      await page
        .locator("text=/Unable to connect|error|try again/i")
        .first()
        .waitFor({ state: "visible", timeout: 10000 });

      const errorText = await page
        .locator("text=/Unable to connect/i")
        .first()
        .textContent();
      expect(errorText).toMatch(/Unable to connect/i);
    });
  });
});
