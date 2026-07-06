import "styled-components/native";
import type { MobileTheme } from "../tokens";

declare module "styled-components/native" {
  export interface DefaultTheme extends MobileTheme {}
}
