import "styled-components/native";
import type { NKSTheme } from "../tokens";

declare module "styled-components/native" {
  export interface DefaultTheme extends NKSTheme {}
}
