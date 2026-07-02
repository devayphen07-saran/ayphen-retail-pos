import { useState } from "react";
import { Platform, Modal, View, Button, TouchableOpacity } from "react-native";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import styled, { useTheme } from "styled-components/native";
import {
  Controller,
  Control,
  FieldValues,
  Path,
  RegisterOptions,
} from "react-hook-form";
import { Typography } from "../typography";
import { X } from "lucide-react-native";
import { Flex } from "../layout";

interface TimePickerProps<T extends FieldValues = FieldValues> {
  value?: Date;
  onChange?: (date?: Date) => void;
  label?: string;
  placeholder?: string;
  name?: Path<T>;
  rules?: RegisterOptions<T, Path<T>>;
  control?: Control<T>;
  errorMessage?: string;
  required?: boolean;
  disabled?: boolean;
}

export function TimeField<T extends FieldValues = FieldValues>({
  value,
  onChange,
  label,
  placeholder = "Select a time",
  name,
  control,
  errorMessage,
  required = false,
  disabled = false,
  rules,
}: TimePickerProps<T>) {
  const [show, setShow] = useState(false);
  const [internalDate, setInternalDate] = useState<Date | undefined>(value);
  const [tempDate, setTempDate] = useState<Date | undefined>(value);
  const theme = useTheme();

  const handleChange = (newDate?: Date, changeFn?: (d?: Date) => void) => {
    setInternalDate(newDate);
    if (changeFn) {
      changeFn(newDate);
    } else {
      onChange?.(newDate);
    }
  };

  const handleConfirm = (changeFn: (date?: Date) => void) => {
    handleChange(tempDate, changeFn);
    setShow(false);
  };

  const formatTime = (date: Date | undefined): string => {
    if (!date) return placeholder;
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  };

  const renderPicker = (
    val: Date | undefined,
    changeFn: (date?: Date) => void
  ) => (
    <Flex flex={1}>
      {label && (
        <View style={{ paddingBottom: 4, marginLeft: 3 }}>
          <Typography.Caption>
            {label}
            {required && (
              <Typography.Caption
                type="secondary"
                style={{ color: theme.colorError }}
              >
                {" *"}
              </Typography.Caption>
            )}
          </Typography.Caption>
        </View>
      )}

      <SelectTouchable
        disabled={disabled}
        onPress={() => !disabled && setShow(true)}
        style={{ opacity: disabled ? 0.6 : 1 }}
      >
        <TextRow>
          <Typography.Body
            type="secondary"
            style={{ flex: 1 }}
            numberOfLines={1}
          >
            {formatTime(val)}
          </Typography.Body>

          {val && !disabled && (
            <TouchableOpacity
              onPress={() => handleChange(undefined, changeFn)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <X size={18} color={theme.colorTextSecondary} />
            </TouchableOpacity>
          )}
        </TextRow>
      </SelectTouchable>

      {errorMessage && (
        <Typography.Caption style={{ color: theme.colorError }}>
          {errorMessage}
        </Typography.Caption>
      )}

      {!disabled && show && (
        <Modal transparent animationType="fade">
          <Backdrop onPress={() => setShow(false)} />
          <PickerContainer>
            <Typography.Body style={{ marginBottom: 6 }}>
              Select Time
            </Typography.Body>
            <DateTimePicker
              value={tempDate || new Date()}
              mode="time"
              display={Platform.OS === "ios" ? "spinner" : "default"}
              onChange={(event: DateTimePickerEvent, selectedTime?: Date) => {
                if (event.type === "set" && selectedTime) {
                  setTempDate(selectedTime);
                }
              }}
            />

            <View style={{ marginTop: 12 }}>
              <Button
                title="Done"
                onPress={() => handleConfirm(changeFn)}
              />
            </View>
          </PickerContainer>
        </Modal>
      )}
    </Flex>
  );

  if (name && control) {
    return (
      <Controller
        name={name}
        control={control}
        rules={rules}
        render={({ field: { value: fieldValue, onChange: fieldOnChange } }) => {
          const handleBothChanges = (date?: Date) => {
            fieldOnChange(date);
            setInternalDate(date);
            onChange?.(date);
          };
          const currentValue = fieldValue ?? internalDate;
          return renderPicker(currentValue, handleBothChanges);
        }}
      />
    );
  }

  return renderPicker(internalDate, handleChange);
}

const SelectTouchable = styled(TouchableOpacity)`
  padding: ${({ theme }) =>
    Platform.OS === "ios" ? theme.padding.small : 10}px;
  background-color: ${({ theme }) => theme.colorBgContainer};
  border-radius: ${({ theme }) => theme.borderRadius.medium}px;
  border-width: 1px;
  border-color: ${({ theme }) => theme.colorBorder};
  margin-bottom: 13px;
`;

const TextRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`;

const Backdrop = styled.TouchableOpacity`
  flex: 1;
  background-color: rgba(0, 0, 0, 0.25);
  justify-content: flex-end;
`;

const PickerContainer = styled(View)`
  background-color: ${({ theme }) => theme.colorBgElevated};
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
  padding: 16px;
`;
