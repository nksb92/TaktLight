import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App scaffold", () => {
  it("renders TaktLight Studio title", () => {
    render(<App />);
    expect(screen.getByText("TaktLight Studio")).toBeInTheDocument();
  });
});
