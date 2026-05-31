import type { ImgHTMLAttributes } from "react";
import { addressFaceDataUri } from "./blockies";

type AddressFaceProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  address: string;
  alt?: string;
};

export function AddressFace({
  address,
  alt = "",
  className = "guzzler-icon",
  width = 40,
  height = 40,
  ...props
}: AddressFaceProps) {
  return (
    <img
      {...props}
      className={className}
      src={addressFaceDataUri(address)}
      alt={alt}
      width={width}
      height={height}
    />
  );
}
