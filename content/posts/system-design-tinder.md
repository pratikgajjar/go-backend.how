+++
title = 'System Design : Tinder ❤️'
description = "Explore the high and low-level design of a Tinder-like application, covering features such as sign-up, profile setup, recommendations, chat, notifications, and user interactions. Learn about system requirements, architecture components, and scalability considerations for handling millions of users and high traffic volumes."
date = 2023-02-15T10:00:00-07:00
draft = false
tags = ['System Design','HLD']
+++

High + Low level design of Tinder

# Requirements

1. Sign Up and Profile Setup: This feature allows users to create an account and set up their profile by entering basic information such as name, age, gender, location, and uploading photos.
2. Recommendation: This feature shows users a list of potential matches based on their preferences and location. The recommendation algorithm takes into account factors such as age, gender, location, and common interests to provide a list of relevant profiles.
3. Profile metadata: This feature allows users to link their Spotify account and display their top choices on their profile. This can help users find matches with similar music tastes.
4. Chat: This feature enables users to communicate with their matches through a messaging interface.
5. Notifications: This feature sends users notifications when they receive a new match, message, or other updates.
Boost, Like, and Super Like: These features allow users to express interest in other profiles and increase their visibility to potential matches. A boost makes a user's profile more visible to other users for a short period of time, a like indicates that a user is interested in another user, and a super like indicates that a user is particularly interested in another user.
6. Top Picks: This feature shows users a curated list of highly-matched profiles that are deemed to be particularly compatible with them.

At a low level, the system could be implemented using a client-server architecture, with the client being a mobile app or web application and the server being a set of backend servers that handle tasks such as recommendation, chat, and notification management. The backend could use a database to store user information and preferences, and could use machine learning algorithms to improve the recommendation and matching processes over time.

## Constraints:
- The system must be able to handle at least 1 million concurrent users and handle peak traffic of at least 10,000 requests per second.
- The system must be able to handle at least 100,000 concurrent chat conversations.
- The system must be able to handle at least 10,000 user profile updates per minute.
- The system must be able to handle at least 10,000 user location updates per minute.
## Assumptions:
- Users will have access to a stable internet connection with a minimum download speed of 2 Mbps.
- Users will have a smartphone or computer with a modern browser that supports HTML5 and JavaScript.
- Users will have a valid phone number for verification purposes, and this number will be unique across all users.
- Users will have a valid payment method, such as a credit card or PayPal account, for purchasing in-app features such as Boost.
- Users will be honest and respectful towards other users, and will not engage in behavior that is deemed inappropriate or harassing.

# High Level Design 

- Client: The client is a mobile app or web application that is used by users to interact with the system.
- Load balancer: The load balancer is responsible for distributing incoming traffic evenly across a group of servers. This helps to ensure that the system can handle high traffic levels and prevent any single server from becoming overloaded.
- Application servers: The application servers are responsible for handling requests from the client and interacting with the database. They handle tasks such as recommendation, chat, and notification management.
- Database: The database stores user information and preferences, as well as metadata about chats and notifications. It is used by the application servers to retrieve and update data as needed.
- Cache: The cache is a temporary storage layer that is used to store frequently accessed data in memory, so that it can be retrieved more quickly. This can help to improve the performance of the system by reducing the number of requests that need to be made to the database.
- Monitoring and logging: The monitoring and logging systems are responsible for tracking the performance and health of the system, as well as collecting data for debugging and analysis purposes.

