# Use a robust Node.js image for the build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./

# Install dependencies
# We install devDependencies here because 'npm run build' (tsc) needs types/compilers
RUN npm install

# Copy source code
COPY . .

# Build the TypeScript project (compiles .ts files into dist/)
RUN npm run build

# -----------------------------------------------------
# Final stage: Create a lightweight runtime image
# -----------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

# Copy only production dependencies and the compiled code from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Copy necessary config files for context
COPY package.json .
COPY tsconfig.json .

# Expose the default port (optional, but good practice)
EXPOSE 3025

# The command runs the compiled JavaScript entry point
CMD ["node", "dist/browser-connector.js"]