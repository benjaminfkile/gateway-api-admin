import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ErrorBoundary from "./ErrorBoundary";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

function Boom(): never {
  throw new Error("kaboom");
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs caught render errors to the console; silence it for clean output.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.restoreAllMocks();
});

function renderBoundary(child: React.ReactNode) {
  return render(
    <ThemeModeProvider>
      <ErrorBoundary>{child}</ErrorBoundary>
    </ThemeModeProvider>,
  );
}

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    renderBoundary(<div>all good</div>);
    expect(screen.getByText("all good")).toBeInTheDocument();
  });

  it("shows a reload card with the error message when a child throws", () => {
    renderBoundary(<Boom />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("reloads the page when Reload is clicked", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });

    renderBoundary(<Boom />);
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
