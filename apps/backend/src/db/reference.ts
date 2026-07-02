import { boolean, integer } from 'drizzle-orm/pg-core';

export const referenceColumns = {
  sortOrder: integer('sort_order').notNull().default(0),
  isHidden:  boolean('is_hidden').notNull().default(false),
  isSystem:  boolean('is_system').notNull().default(false),
  isActive:  boolean('is_active').notNull().default(true),
};
