# Use official Node.js runtime as parent image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application source
COPY . .

# Expose the port the app runs on
EXPOSE 7860

# Set environment variable for port
ENV PORT=7860

# Start the application
CMD ["npm", "start"]
