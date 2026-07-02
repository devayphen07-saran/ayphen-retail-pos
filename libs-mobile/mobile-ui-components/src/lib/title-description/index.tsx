import React from "react";
import { Typography } from "../typography";
import { Flex } from "../layout";


type flexDirectionType = "row" | "column";
interface TitleDescriptionProps {
  title?: string;
  content?: React.ReactNode;
  description?: string | number;
  direction?: flexDirectionType;
}

export const TitleDescription: React.FC<TitleDescriptionProps> = ({
  title,
  content,
  description,
  direction,
}) => {
  return (
    <Flex gap={2} direction={direction}>
      <Typography.Caption type="secondary">{title}</Typography.Caption>
      <Typography.Caption weight={"medium"} type="default">
        {description}
      </Typography.Caption>
      {content}
    </Flex>
  );
};
