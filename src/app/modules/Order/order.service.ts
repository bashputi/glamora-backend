import { ORDER_STATUS, Prisma } from "@prisma/client";
import prisma from "../../utils/prisma";
import { IPaginationOptions } from "../../interface/pagination.interface";
import { paginationHelper } from "../../utils/paginationHelper";
import { JwtPayload } from "jsonwebtoken";
import ApiError from "../../errors/ApiError";
import { IOrderRequest } from "./order.interface";
import { initiatePayment } from "../Payment/payment.utills";


const createOrderIntoDB = async (
  orderInfo: IOrderRequest,
  userData: JwtPayload & { role: string; userEmail: string }
) => {
  // Fetch customer data using the user's email
  const customerData = await prisma.customer.findUnique({
    where: { email: userData.userEmail },
  });

  if (!customerData) {
    throw new ApiError(404, "Customer not found for payment");
  }

  // Fetch blacklisted shops
  const blacklistedShops = await prisma.shop.findMany({
    where: { isBlackListed: true },
    select: { shopId: true }, // Only retrieve shop IDs
  });

  const blacklistedShopIds = blacklistedShops.map((shop) => shop.shopId);

  // Check if any shop in the order items is blacklisted
  const blacklistedInOrder = orderInfo.items.find((item) =>
    blacklistedShopIds.includes(item.shopId)
  );

  if (blacklistedInOrder) {
    throw new ApiError(
      400,
      `Order cannot be placed as shop ${blacklistedInOrder.shopId} is blacklisted.`
    );
  }

  const generateTransactionId = () => {
    const timestamp = Date.now(); // Current timestamp
    const randomNum = Math.floor(Math.random() * 100000); // Random number
    return `TXN-${timestamp}-${randomNum}`; // Concatenate to create a unique ID
  };

  // Create the order in the database
  const orderData = await prisma.order.create({
    data: {
      couponId: orderInfo.couponId,
      subTotal: orderInfo.subTotal,
      total: orderInfo.total,
      discounts: orderInfo.discounts,
      customerId: customerData.customerId,
      transactionId: generateTransactionId(),
      paymentStatus: "PENDING",
      items: {
        create: orderInfo.items.map((item) => ({
          shopId: item.shopId,
          productId: item.productId,
          size: item.size,
          quantity: item.quantity,
          price: item.price,
          discount: item.discount,
        })),
      },
    },
  });

  // Initiate payment process
  const paymentInfo = await initiatePayment({
    orderData: orderData.subTotal,
    txn: orderData.transactionId,
    customerData,
    orderId: orderData.id,
  });

  return { ...orderData, payLink: paymentInfo.data.payment_url };
};

const getSingleCustomerAllOrder = async (
  userInfo: JwtPayload & { userEmail: string; role: string },
  paginationData: IPaginationOptions,
  params: Record<string, unknown>
) => {
  const { page, limit, skip } =
    paginationHelper.calculatePagination(paginationData);

  const userData = await prisma.customer.findUnique({
    where: {
      email: userInfo.userEmail,
    },
  });

  const { searchTerm, ...filterData } = params;
  let andCondtion: Prisma.OrderWhereInput[] = [];
  if (Object.keys(filterData).length > 0) {
    andCondtion.push({
      AND: Object.keys(filterData)
        .filter((field) => Boolean(filterData[field])) // Exclude all falsy values
        .map((field) => ({
          [field]: {
            equals: filterData[field],
            // mode: "insensitive", // Uncomment if needed for case-insensitive search
          },
        })),
    });
  }

  andCondtion.push({ AND: [{ customerId: userData?.customerId }] });
  const whereConditons: Prisma.OrderWhereInput = { AND: andCondtion };

  const result = await prisma.order.findMany({
    where: whereConditons,
    include: { items: { include: { product: true } } },
    skip: skip,
    take: limit,
    orderBy: paginationData?.sort
      ? {
          [paginationData.sort.split("-")[0]]:
            paginationData.sort.split("-")[1],
        }
      : {
          createdAt: "desc",
        },
  });

  const total = await prisma.order.count();

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data: result,
  };
};

const getSingleOrder = async (id: string) => {
  const result = await prisma.order.findUniqueOrThrow({
    where: {
      id,
    },
    include: { items: { include: { product: true, shop: true } } },
  });

  return result;
};

const getAllOrder = async (paginationData: IPaginationOptions) => {
  const { page, limit, skip } =
    paginationHelper.calculatePagination(paginationData);
  const result = await prisma.order.findMany({
    include: {
      items: { include: { product: true, shop: true } },
      customer: true,
    },
    skip: skip,
    take: limit,
    orderBy: paginationData?.sort
      ? {
          [paginationData.sort.split("-")[0]]:
            paginationData.sort.split("-")[1],
        }
      : {
          createdAt: "desc",
        },
  });

  const total = await prisma.order.count();

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data: result,
  };
};

const getPendingOrder = async (paginationData: IPaginationOptions) => {
  const { page, limit, skip } =
    paginationHelper.calculatePagination(paginationData);
  const result = await prisma.order.findMany({
    where: { status: { not: "DELIVERED" } },
    include: {
      items: { include: { product: true, shop: true } },
      customer: true,
    },
    skip: skip,
    take: limit,
    orderBy: paginationData?.sort
      ? {
          [paginationData.sort.split("-")[0]]:
            paginationData.sort.split("-")[1],
        }
      : {
          createdAt: "desc",
        },
  });
  const total = await prisma.order.count({
    where: { status: { not: "DELIVERED" } },
  });
  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data: result,
  };
};

const updateOrder = async (id: string) => {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) {
    throw new Error(`Order with ID ${id} not found`);
  }

  const statusSequence: Record<string, string> = {
    PENDING: "ONGOING",
    ONGOING: "DELIVERED",
    DELIVERED: "DELIVERED", 
  };
  // Get the next status based on the current status
  const currentStatus = order.status;
  const nextStatus = statusSequence[currentStatus];

  if (!nextStatus) {
    throw new Error(`Invalid current status: ${currentStatus}`);
  }

  // Update the order status to the next status
  const result = await prisma.order.update({
    where: { id },
    data: {
      status: nextStatus as ORDER_STATUS,
    },
  });

  return result;
};

const getSpecificShopOrder = async (
  userData: JwtPayload & { userEmail: string; role: string },
  paginationData: IPaginationOptions,
  params: Record<string, unknown>
) => {
  const vendor = await prisma.vendor.findUniqueOrThrow({
    where: { email: userData.userEmail },
  });
  const { page, limit, skip } =
    paginationHelper.calculatePagination(paginationData);

  const { searchTerm, ...filterData } = params;
  let andCondtion: Prisma.OrderWhereInput[] = [];
  if (Object.keys(filterData).length > 0) {
    andCondtion.push({
      AND: Object.keys(filterData)
        .filter((field) => Boolean(filterData[field])) // Exclude all falsy values
        .map((field) => ({
          [field]: {
            equals: filterData[field],
            // mode: "insensitive", // Uncomment if needed for case-insensitive search
          },
        })),
    });
  }
  andCondtion.push({
    AND: [
      {
        items: {
          some: {
            shop: { vendorId: vendor.vendorId }, // Replace 'your-shop-id' with the desired shop ID
          },
        },
      },
    ],
  });

  console.dir(andCondtion, { depth: null });

  const whereConditons: Prisma.OrderWhereInput = { AND: andCondtion };
  const orders = await prisma.order.findMany({
    where: whereConditons,
    include: {
      items: { include: { product: true } }, // Include order items if needed
      customer: true, // Include customer details if needed
    },
    skip: skip,
    take: limit,
    orderBy: paginationData?.sort
      ? {
          [paginationData.sort.split("-")[0]]:
            paginationData.sort.split("-")[1],
        }
      : {
          createdAt: "desc",
        },
  });

  console.log(skip);
  const total = await prisma.order.count({
    where: whereConditons,
  });

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data: orders,
  };
};

export const OrderService = {
  createOrderIntoDB,
  getSingleCustomerAllOrder,
  getSingleOrder,
  getAllOrder,
  updateOrder,
  getPendingOrder,
  getSpecificShopOrder,
};


