/**
 * INVENTED DATA. No real dealership, stock, prices or customers appear anywhere
 * in this repository. These cars do not exist.
 */
export interface Car {
  id: string;
  model: string;
  year: number;
  transmission: "manual" | "automatic";
  colour: string;
  priceUsd: number;
}

export const STOCK: readonly Car[] = [
  { id: "A-1", model: "Corolla", year: 2022, transmission: "automatic", colour: "silver", priceUsd: 18_500 },
  { id: "A-2", model: "Corolla", year: 2021, transmission: "manual", colour: "white", priceUsd: 16_900 },
  { id: "B-1", model: "Hilux", year: 2023, transmission: "automatic", colour: "grey", priceUsd: 41_000 },
  { id: "C-1", model: "Yaris", year: 2020, transmission: "manual", colour: "red", priceUsd: 12_400 },
];
