import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationRequest {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  page: number = 0;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @IsString()
  sortBy: string = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir: 'asc' | 'desc' = 'desc';

  get offset(): number {
    return this.page * this.pageSize;
  }

  get limit(): number {
    return this.pageSize;
  }
}

export class PaginationResponse<T> {
  constructor(
    public readonly content: T[],
    public readonly page: number,
    public readonly pageSize: number,
    public readonly totalElements: number,
    public readonly totalPages: number,
    public readonly isFirst: boolean,
    public readonly isLast: boolean,
  ) {}

  static of<T>(
    content: T[],
    totalElements: number,
    req: PaginationRequest,
  ): PaginationResponse<T> {
    const totalPages = Math.ceil(totalElements / req.pageSize);

    return new PaginationResponse(
      content,
      req.page,
      req.pageSize,
      totalElements,
      totalPages,
      req.page === 0,
      req.page >= Math.max(totalPages - 1, 0),
    );
  }
}
