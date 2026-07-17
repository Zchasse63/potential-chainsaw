This guide provides a high‑level overview of the core entities used to integrate with Glofox’s CRM and Member Management System (MMS), with the Fitness Center Member as the central pivot. It outlines how Locations contextualize services, Plans define offerings, Memberships bind members to plans, and Credits enable access. It also covers how Events and Bookings coordinate participation and how Purchase endpoints support pricing and payments. Use this model to map your app to Glofox concepts and plan common workflows like onboarding, scheduling, attendance, and billing.

flowchart LR LB(["Location | Branch"]) MP(["Membership | Plan"]) LM(["Lead | Member"]) UM([User Membership]) PUR([Purchase]) CR([Credits]) BK([Booking]) EV([Events]) PC(["Program | Course"]) LB --- MP MP --- UM LM --- UM UM --- PUR UM --- CR LM --- BK CR --- BK BK --- EV EV --- PC

The table below summarizes the core entities in Glofox’s CRM/MMS, with concise definitions, purposes, and key attributes to guide integration design.

Entity | Definition | Purpose | Key Attributes  
---|---|---|---  
**Location (Branch)** | Represents the physical space where the location offers services (for example, gym, studio, club, training location). | Stores membership details, class schedules, and geographical information for member access. | Name, address, contact info  
**Member** | A registered individual with an account in the location. Includes leads and ex-members. | Owns the membership and is the primary entity to book services. | Name, Contact Details, Membership Status, Access Permissions  
**Plan** | A specific arrangement of services or activities offered to members; a contract defining terms and conditions. | Provides structure for offerings, defining activities, duration, pricing, and restrictions. | Name and description, Duration and subscription cycle, Price, Credits granted  
**Membership** | A record of a member’s subscription to a specific Plan. | Tracks membership status and supports access and billing management. | Member ID, Plan ID, Membership Status, Membership Type, Access Permissions  
**Credits** | A unit of value representing a specific amount of service or reward. | Tracks the amount of access a member has purchased for use in bookings. | Type (Classes, Appointments, Facilities), Quantity  
**Events** | Scheduled activities members can participate in. | Manage class schedules, attendance tracking, and availability. | Name, Start Time, Duration, Capacity, Description, Required Plan/Membership  
**Bookings** | A record of a member’s intent to attend a specific event. | Captures the booking history. | Booking ID, Member ID, Event ID, Status, Attendance  
**Purchase** | Endpoints that handle payment methods and calculate membership/booking prices. | Enables payment gateway integrations and secure membership/booking transactions. | Payment Method, Price Calculation Rules
