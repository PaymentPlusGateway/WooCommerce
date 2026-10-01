/**
 * Express Checkout Handler
 * 
 * Manages unified Google Pay and Apple Pay checkout experience
 */

const ExpressCheckout = {
	config: {
		googlePayVersion: 2,
		applePayVersion: 4,
		defaultCountry: expressCheckoutVars?.country || 'US',
		currency: expressCheckoutVars?.currency || 'USD',
	},

	state: {
		cartData: null,
		selectedMethod: null,
		shippingMethod: null,
		contactInfo: null,
		paymentToken: null,
	},

	/**
	 * Initialize Express Checkout
	 */
	async init() {
		console.log('[Express Checkout] Initializing...');

		// Fetch initial cart data
		await this.fetchCartData();

		// Initialize payment methods
		if (this.canUseApplePay()) {
			this.initApplePay();
		}

		if (this.canUseGooglePay()) {
			this.initGooglePay();
		}

		// Setup modal handlers
		this.setupModalHandlers();

		// Setup event listeners
		jQuery(document.body).on('updated_checkout', () => {
			this.fetchCartData();
		});

		jQuery(document.body).on('updated_cart', () => {
			this.fetchCartData();
		});
	},

	/**
	 * Fetch cart data from server
	 */
	async fetchCartData() {
		try {
			const response = await this.makeAjaxRequest('express_checkout_init', {});
			if (response.success) {
				this.state.cartData = response.data;
				console.log('[Express Checkout] Cart data updated', this.state.cartData);
			}
		} catch (error) {
			console.error('[Express Checkout] Error fetching cart data:', error);
			this.showError('Failed to load cart data');
		}
	},

	/**
	 * Check if Apple Pay is available
	 */
	canUseApplePay() {
		return typeof ApplePaySession !== 'undefined' && ApplePaySession.canMakePayments();
	},

	/**
	 * Check if Google Pay is available
	 */
	canUseGooglePay() {
		return typeof google !== 'undefined' && typeof google.payments !== 'undefined';
	},

	/**
	 * Initialize Apple Pay
	 */
	initApplePay() {
		console.log('[Express Checkout] Initializing Apple Pay');

		const button = document.getElementById('wc-apple-pay-button');
		if (!button) return;

		button.textContent = 'Apple Pay';
		document.getElementById('wc-apple-pay-container').style.display = 'flex';

		button.addEventListener('click', (e) => this.handleApplePayClick(e));
	},

	/**
	 * Handle Apple Pay click
	 */
	async handleApplePayClick(event) {
		event.preventDefault();

		if (!this.state.cartData) {
			await this.fetchCartData();
		}

		const paymentRequest = this.buildApplePayRequest();

		try {
			const session = new ApplePaySession(this.config.applePayVersion, paymentRequest);

			session.onvalidatemerchant = (event) => {
				// In production, you would validate with Apple
				// For now, we'll use gateway validation
				session.completeMerchantValidation({});
			};

			session.onshippingcontactselected = (event) => {
				this.handleApplePayShippingContact(session, event);
			};

			session.onshippingmethodselected = (event) => {
				this.handleApplePayShippingMethod(session, event);
			};

			session.onpaymentauthorized = (event) => {
				this.handleApplePayAuthorization(session, event);
			};

			session.oncancel = () => {
				console.log('[Express Checkout] Apple Pay cancelled');
			};

			session.begin();
			this.state.selectedMethod = 'applepay';
		} catch (error) {
			console.error('[Express Checkout] Apple Pay error:', error);
			this.showError('Apple Pay is not available');
		}
	},

	/**
	 * Handle Apple Pay shipping contact selection
	 */
	async handleApplePayShippingContact(session, event) {
		const contact = event.shippingContact;

		this.state.contactInfo = {
			first_name: contact.givenName,
			last_name: contact.familyName,
			email: contact.emailAddress,
			phone: contact.phoneNumber,
			address_1: contact.addressLines?.[0] || '',
			address_2: contact.addressLines?.[1] || '',
			city: contact.locality,
			state: contact.administrativeArea,
			postcode: contact.postalCode,
			country: contact.countryCode,
		};

		// Fetch shipping methods for this address
		const shippingMethods = await this.getShippingMethods(contact.countryCode);

		const result = {
			newShippingMethods: shippingMethods,
			newTotal: {
				label: 'Total',
				amount: this.state.cartData.total,
			},
		};

		session.completeShippingContactSelection(result);
	},

	/**
	 * Handle Apple Pay shipping method selection
	 */
	async handleApplePayShippingMethod(session, event) {
		const method = event.shippingMethod;

		try {
			const response = await this.makeAjaxRequest('express_checkout_shipping', {
				shipping_method: method.identifier,
				country: this.state.contactInfo.country,
			});

			if (response.success) {
				session.completeShippingMethodSelection({
					newTotal: {
						label: 'Total',
						amount: response.data.total,
					},
				});

				this.state.shippingMethod = method.identifier;
			}
		} catch (error) {
			console.error('[Express Checkout] Shipping method error:', error);
			session.completeShippingMethodSelection({
				errors: [
					new ApplePayError('shippingContactInvalid', 'postalAddress', error.message),
				],
			});
		}
	},

	/**
	 * Handle Apple Pay authorization
	 */
	async handleApplePayAuthorization(session, event) {
		this.showLoading(true);

		try {
			const tokenData = event.payment.token.paymentData;

			const response = await this.makeAjaxRequest('express_checkout_payment', {
				payment_method: 'applepay',
				payment_token: JSON.stringify(tokenData),
				contact_info: this.state.contactInfo,
			});

			if (response.success) {
				session.completePayment(ApplePaySession.STATUS_SUCCESS);
				window.location.href = response.data.redirect;
			} else {
				session.completePayment(ApplePaySession.STATUS_FAILURE);
				this.showError(response.data.message || 'Payment failed');
			}
		} catch (error) {
			console.error('[Express Checkout] Authorization error:', error);
			session.completePayment(ApplePaySession.STATUS_FAILURE);
			this.showError(error.message);
		} finally {
			this.showLoading(false);
		}
	},

	/**
	 * Build Apple Pay request
	 */
	buildApplePayRequest() {
		const lineItems = (this.state.cartData.line_items || []).map((item) => ({
			label: item.label,
			amount: item.amount,
		}));

		if (this.state.cartData.shipping_total) {
			lineItems.push({
				label: 'Shipping',
				amount: this.state.cartData.shipping_total,
			});
		}

		const request = {
			countryCode: this.config.defaultCountry,
			currencyCode: this.config.currency,
			supportedNetworks: ['visa', 'masterCard', 'amex', 'discover'],
			merchantCapabilities: ['supports3DS'],
			total: {
				label: 'Total',
				amount: this.state.cartData.total,
			},
			lineItems: lineItems,
		};

		if (this.state.cartData.requires_shipping) {
			request.requiredBillingContactFields = ['email', 'name', 'phone', 'postalAddress'];
			request.requiredShippingContactFields = ['email', 'name', 'phone', 'postalAddress'];
			request.shippingMethods = this.state.cartData.shipping_methods || [];
		}

		return request;
	},

	/**
	 * Initialize Google Pay
	 */
	initGooglePay() {
		console.log('[Express Checkout] Initializing Google Pay');

		const button = document.getElementById('wc-google-pay-button');
		if (!button) return;

		document.getElementById('wc-google-pay-container').style.display = 'flex';

		button.addEventListener('click', (e) => this.handleGooglePayClick(e));
	},

	/**
	 * Handle Google Pay click
	 */
	async handleGooglePayClick(event) {
		event.preventDefault();

		if (!this.state.cartData) {
			await this.fetchCartData();
		}

		try {
			const paymentRequest = this.buildGooglePayRequest();
			const paymentsClient = new google.payments.api.PaymentsClient({
				environment: 'PRODUCTION', // Change to TEST for testing
			});

			paymentsClient.loadPaymentData(paymentRequest).then((paymentData) => {
				this.handleGooglePayResponse(paymentData);
			});
		} catch (error) {
			console.error('[Express Checkout] Google Pay error:', error);
			this.showError('Google Pay is not available');
		}
	},

	/**
	 * Build Google Pay request
	 */
	buildGooglePayRequest() {
		const paymentDataRequest = {
			apiVersion: this.config.googlePayVersion,
			apiVersionMinor: 0,
			allowedPaymentMethods: [
				{
					type: 'CARD',
					parameters: {
						allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
						allowedCardNetworks: ['MASTERCARD', 'VISA', 'AMEX', 'DISCOVER'],
					},
					tokenizationSpecification: {
						type: 'PAYMENT_GATEWAY',
						parameters: {
							gateway: 'example', // Replace with your gateway
							gatewayMerchantId: 'YOUR_MERCHANT_ID', // Replace
						},
					},
				},
			],
			transactionInfo: {
				totalPriceStatus: 'FINAL',
				totalPrice: this.state.cartData.total,
				currencyCode: this.config.currency,
			},
		};

		if (this.state.cartData.requires_shipping) {
			paymentDataRequest.shippingAddressRequired = true;
			paymentDataRequest.shippingAddressParameters = {
				allowedCountryCodes: ['US'], // Add your allowed countries
				format: 'FULL',
			};
		}

		return paymentDataRequest;
	},

	/**
	 * Handle Google Pay response
	 */
	async handleGooglePayResponse(paymentData) {
		this.showLoading(true);

		try {
			// Extract payment token
			const paymentMethod = paymentData.paymentMethodData;
			const paymentToken = paymentMethod.tokenizationData.token;

			// Extract address if available
			if (paymentData.shippingAddress) {
				this.state.contactInfo = {
					first_name: paymentData.shippingAddress.name?.split(' ')[0] || '',
					last_name: paymentData.shippingAddress.name?.split(' ').slice(1).join(' ') || '',
					email: paymentData.email || '',
					phone: paymentData.shippingAddress.phoneNumber || '',
					address_1: paymentData.shippingAddress.address1 || '',
					address_2: paymentData.shippingAddress.address2 || '',
					city: paymentData.shippingAddress.locality || '',
					state: paymentData.shippingAddress.administrativeArea || '',
					postcode: paymentData.shippingAddress.postalCode || '',
					country: paymentData.shippingAddress.countryCode || this.config.defaultCountry,
				};
			} else {
				// Show modal for contact info if not provided
				await this.showContactModal();
			}

			const response = await this.makeAjaxRequest('express_checkout_payment', {
				payment_method: 'googlepay',
				payment_token: paymentToken,
				contact_info: this.state.contactInfo,
			});

			if (response.success) {
				window.location.href = response.data.redirect;
			} else {
				this.showError(response.data.message || 'Payment failed');
			}
		} catch (error) {
			console.error('[Express Checkout] Google Pay response error:', error);
			this.showError(error.message);
		} finally {
			this.showLoading(false);
		}
	},

	/**
	 * Get shipping methods for country
	 */
	async getShippingMethods(countryCode) {
		if (!this.state.cartData) return [];

		return this.state.cartData.shipping_methods.map((method) => ({
			identifier: method.id,
			label: method.label,
			detail: method.detail,
			amount: method.amount,
		}));
	},

	/**
	 * Show contact info modal
	 */
	async showContactModal() {
		return new Promise((resolve) => {
			const modal = document.getElementById('wc-express-checkout-modal');
			const closeBtn = modal.querySelector('.wc-express-checkout-modal-close');

			const form = `
				<form id="wc-express-checkout-form">
					<div class="wc-express-checkout-form-group">
						<label for="express_first_name">First Name *</label>
						<input type="text" id="express_first_name" name="first_name" required>
					</div>
					<div class="wc-express-checkout-form-group">
						<label for="express_last_name">Last Name *</label>
						<input type="text" id="express_last_name" name="last_name" required>
					</div>
					<div class="wc-express-checkout-form-group">
						<label for="express_email">Email *</label>
						<input type="email" id="express_email" name="email" required>
					</div>
					<div class="wc-express-checkout-form-group">
						<label for="express_phone">Phone *</label>
						<input type="tel" id="express_phone" name="phone" required>
					</div>
					<div class="wc-express-checkout-form-group">
						<label for="express_address_1">Address *</label>
						<input type="text" id="express_address_1" name="address_1" required>
					</div>
					<div class="wc-express-checkout-form-group">
						<label for="express_address_2">Address 2</label>
						<input type="text" id="express_address_2" name="address_2">
					</div>
					<div class="wc-express-checkout-form-row">
						<div class="wc-express-checkout-form-group">
							<label for="express_city">City *</label>
							<input type="text" id="express_city" name="city" required>
						</div>
						<div class="wc-express-checkout-form-group">
							<label for="express_state">State *</label>
							<input type="text" id="express_state" name="state" required>
						</div>
					</div>
					<div class="wc-express-checkout-form-row">
						<div class="wc-express-checkout-form-group">
							<label for="express_postcode">Postcode *</label>
							<input type="text" id="express_postcode" name="postcode" required>
						</div>
						<div class="wc-express-checkout-form-group">
							<label for="express_country">Country *</label>
							<input type="text" id="express_country" name="country" value="${this.config.defaultCountry}" required>
						</div>
					</div>
					<button type="submit" class="wc-express-checkout-continue-btn" style="width: 100%; padding: 12px; background: #4285F4; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 12px;">Continue to Payment</button>
				</form>
			`;

			document.getElementById('wc-express-checkout-modal-body-content').innerHTML = form;
			modal.classList.add('active');
			modal.style.display = 'flex';

			const form_elem = document.getElementById('wc-express-checkout-form');
			form_elem.addEventListener('submit', (e) => {
				e.preventDefault();

				const formData = new FormData(form_elem);
				this.state.contactInfo = Object.fromEntries(formData);

				modal.classList.remove('active');
				modal.style.display = 'none';

				resolve();
			});

			closeBtn.addEventListener('click', () => {
				modal.classList.remove('active');
				modal.style.display = 'none';
				resolve();
			});

			modal.addEventListener('click', (e) => {
				if (e.target === modal) {
					modal.classList.remove('active');
					modal.style.display = 'none';
					resolve();
				}
			});
		});
	},

	/**
	 * Setup modal handlers
	 */
	setupModalHandlers() {
		const modal = document.getElementById('wc-express-checkout-modal');
		if (!modal) return;

		const closeBtn = modal.querySelector('.wc-express-checkout-modal-close');
		if (closeBtn) {
			closeBtn.addEventListener('click', () => {
				modal.classList.remove('active');
				modal.style.display = 'none';
			});
		}
	},

	/**
	 * Make AJAX request
	 */
	makeAjaxRequest(action, data) {
		return new Promise((resolve, reject) => {
			jQuery.ajax({
				url: expressCheckoutVars.ajaxurl,
				type: 'POST',
				dataType: 'json',
				data: {
					action: action,
					nonce: expressCheckoutVars.nonce,
					...data,
				},
				success: (response) => {
					if (response.success) {
						resolve(response);
					} else {
						reject(new Error(response.data?.message || 'Request failed'));
					}
				},
				error: (error) => {
					reject(error);
				},
			});
		});
	},

	/**
	 * Show loading state
	 */
	showLoading(show) {
		const loading = document.getElementById('wc-express-checkout-loading');
		if (loading) {
			loading.style.display = show ? 'flex' : 'none';
		}
	},

	/**
	 * Show error message
	 */
	showError(message) {
		const errorEl = document.getElementById('wc-express-checkout-error');
		const errorText = errorEl?.querySelector('.wc-express-checkout-error-text');

		if (errorText) {
			errorText.textContent = message;
			errorEl.style.display = 'block';

			setTimeout(() => {
				errorEl.style.display = 'none';
			}, 5000);
		}
	},
};

// Initialize on document ready
jQuery(document).ready(() => {
	ExpressCheckout.init();
});
