export interface CartLine {
  productId: string;
  productGuuid: string;
  name: string;
  unitPricePaise: number;
  qty: number;
}

export function cartTotalPaise(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + Math.round(l.qty * l.unitPricePaise), 0);
}